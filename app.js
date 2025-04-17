const express = require('express');
const promClient = require('prom-client');
const winston = require('winston');
const LokiTransport = require('winston-loki');
const app = express();
const PORT = process.env.PORT || 8000;


// Set up Prometheus metrics
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Custom metrics
const httpRequestDurationMicroseconds = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10]
});

const httpRequestCounter = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

const errorCounter = new promClient.Counter({
  name: 'app_errors_total',
  help: 'Total number of application errors',
  labelNames: ['route', 'error_type']
});

register.registerMetric(httpRequestDurationMicroseconds);
register.registerMetric(httpRequestCounter);
register.registerMetric(errorCounter);


const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'mock-api-service' },
  transports: [
    new winston.transports.Console(),
    new LokiTransport({
      host: "http://loki:3100",
      labels: { application: 'mock-api-service' },
      json: true,
      batching: true,
      interval: 5,
      gracefulShutdown: true
    })
  ]
});

// Middleware to track request duration and count
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.path;
    const statusCode = res.statusCode.toString();
    
    httpRequestDurationMicroseconds
      .labels(req.method, route, statusCode)
      .observe(duration);
    
    httpRequestCounter
      .labels(req.method, route, statusCode)
      .inc();
    
    logger.info({
      message: `${req.method} ${route} ${statusCode}`,
      labels: {
        method: req.method,
        route,
        statusCode,
        duration: duration.toFixed(3),
        userAgent: req.get('user-agent') || 'unknown'
      }
    });
  });
  
  next();
});

// Fast endpoint - responds quickly
app.get('/api/fast', (req, res) => {
  logger.info({
    message: 'Fast API called',
    labels: { endpoint: 'fast' }
  });
  res.json({ message: 'This is a fast response', time: new Date() });
});

// Slow endpoint - artificial delay
app.get('/api/slow', (req, res) => {
  logger.info({
    message: 'Slow API called - starting delay',
    labels: { endpoint: 'slow', state: 'starting' }
  });
  
  setTimeout(() => {
    logger.info({
      message: 'Slow API responding after delay',
      labels: { endpoint: 'slow', state: 'completed' }
    });
    res.json({ message: 'This is a slow response', time: new Date() });
  }, 2000 + Math.random() * 3000); // Random delay between 2-5 seconds
});

// Faulty endpoint - sometimes returns errors
app.get('/api/faulty', (req, res) => {
  logger.info({
    message: 'Faulty API called',
    labels: { endpoint: 'faulty' }
  });
  
  // 40% chance of error
  if (Math.random() < 0.4) {
    const errorTypes = ['timeout', 'invalid_data', 'service_unavailable'];
    const errorType = errorTypes[Math.floor(Math.random() * errorTypes.length)];
    
    errorCounter.labels('/api/faulty', errorType).inc();
    
    logger.error({
      message: `Faulty API error: ${errorType}`,
      labels: {
        endpoint: 'faulty',
        errorType,
        route: '/api/faulty'
      }
    });
    
    res.status(500).json({ 
      error: true, 
      type: errorType,
      message: `Simulated error: ${errorType}` 
    });
  } else {
    res.json({ message: 'Faulty endpoint worked this time!', time: new Date() });
  }
});

// Memory leak simulation endpoint
app.get('/api/memory-leak', (req, res) => {
  logger.info({
    message: 'Memory leak simulation API called',
    labels: { endpoint: 'memory-leak' }
  });
  
  // This is a simulated memory leak - don't do this in real applications!
  global.leakyArray = global.leakyArray || [];
  
  // Add a large object to the global array
  const leakyObject = {
    timestamp: new Date(),
    data: Buffer.alloc(1024 * 1024) // Allocate 1MB
  };
  
  global.leakyArray.push(leakyObject);
  
  logger.warn({
    message: 'Memory leak simulation - added 1MB to memory',
    labels: {
      endpoint: 'memory-leak',
      totalLeakedMB: global.leakyArray.length
    }
  });
  
  res.json({ 
    message: 'Memory leak simulated', 
    leakedMB: global.leakyArray.length,
    time: new Date() 
  });
});

// Load test endpoint - CPU intensive
app.get('/api/cpu-intensive', (req, res) => {
  logger.info({
    message: 'CPU intensive API called',
    labels: { endpoint: 'cpu-intensive', state: 'starting' }
  });
  
  const start = Date.now();
  let counter = 0;
  
  // CPU intensive operation
  for (let i = 0; i < 10000000; i++) {
    counter += Math.sqrt(i);
  }
  
  const duration = (Date.now() - start) / 1000;
  
  logger.info({
    message: 'CPU intensive operation completed',
    labels: {
      endpoint: 'cpu-intensive',
      state: 'completed',
      duration: duration.toFixed(3),
      result: counter.toFixed(0)
    }
  });
  
  res.json({ 
    message: 'CPU intensive operation completed', 
    duration,
    time: new Date() 
  });
});

// Metrics endpoint for Prometheus to scrape
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Root endpoint - API documentation
app.get('/', (req, res) => {
  res.json({
    name: 'Observable Mock API Service',
    version: '1.0.0',
    endpoints: [
      { path: '/api/fast', description: 'Fast responding API' },
      { path: '/api/slow', description: 'Slow responding API (2-5s delay)' },
      { path: '/api/faulty', description: 'Occasionally failing API (40% error rate)' },
      { path: '/api/memory-leak', description: 'Simulates a memory leak (adds 1MB each call)' },
      { path: '/api/cpu-intensive', description: 'CPU intensive operation' },
      { path: '/metrics', description: 'Prometheus metrics endpoint' },
      { path: '/health', description: 'Health check endpoint' }
    ]
  });
});

app.listen(PORT, () => {
  logger.info({
    message: `Server started on port ${PORT}`,
    labels: { event: 'server_start', port: PORT }
  });
  console.log(`Server started on port ${PORT}`);
});