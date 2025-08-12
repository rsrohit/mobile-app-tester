// Core modules
const http = require('http');
const path = require('path');

// Third‑party modules
const express = require('express');
const { Server } = require('socket.io');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// Local modules
const config = require('./config');
const apiRoutes = require('./api/routes');

// Instantiate Express and HTTP server
const app = express();
const server = http.createServer(app);

// Configure Socket.IO with CORS reflecting our allowed origins
const io = new Server(server, {
  cors: {
    origin: config.allowedOrigin === '*'
      ? '*'
      : config.allowedOrigin.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST'],
  },
});

// -------------------------------------------------------------
// Global Middleware
// -------------------------------------------------------------

// Set various HTTP headers for security
app.use(helmet());

// Gzip/deflate compress all responses
app.use(compression());

// Request logging (combined format includes user agent, status, etc.)
app.use(morgan('combined'));

// Enable JSON and URL encoded body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply CORS.  Accept multiple origins if provided; otherwise fall back
// to '*'.  When '*' is used, the Access‑Control‑Allow‑Origin header
// reflects the wildcard.  For a comma‑separated list, only those
// origins will be allowed.
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || config.allowedOrigin === '*') return callback(null, true);
      const allowed = config.allowedOrigin.split(',').map((o) => o.trim());
      return allowed.includes(origin) ? callback(null, true) : callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: false,
  }),
);

// Apply a simple rate limiter to protect against brute force and DOS.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // limit each IP to 300 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Serve the frontend UI statically.  If the directory does not exist,
// Express will ignore this middleware.
app.use(express.static(config.frontendPath));

// -------------------------------------------------------------
// Routes
// -------------------------------------------------------------

// Mount API routes and provide the socket.io instance.  The
// implementation of routes returns a configured router.
app.use('/api', apiRoutes(io));

// Serve the main frontend page for the root path.  Without this
// fallback, navigating to '/' would trigger the 404 handler and return
// JSON instead of the index.html.  Any non-API route can fall back to
// serving the index page here if desired.
app.get('/', (req, res) => {
  res.sendFile(path.join(config.frontendPath, 'index.html'), (err) => {
    if (err) {
      // If sending the file fails, forward to the error handler
      return res.status(500).json({ message: 'Unable to serve frontend index.html' });
    }
  });
});

// -------------------------------------------------------------
// WebSocket Handling
// -------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`A user connected with socket id: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`User with socket id: ${socket.id} disconnected`);
  });
});

// -------------------------------------------------------------
// Error Handling
// -------------------------------------------------------------

// Catch 404 and forward to error handler
app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// Centralized error handler.  Always return JSON to the client.  If
// headers are already sent, delegate to default Express error handler.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  // Log the error stack for debugging
  console.error(err);
  res.status(status).json({ message });
});

// -------------------------------------------------------------
// Startup
// -------------------------------------------------------------

server.listen(config.port, () => {
  console.log(`Server is running on http://localhost:${config.port}`);
  console.log(`Frontend served from: ${config.frontendPath}`);
});