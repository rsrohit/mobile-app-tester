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

// Normalize allowed origins into an array for reuse across CORS, Socket.IO
// and CSP configuration.  When a wildcard is provided we pass it through so
// localhost, LAN IPs, and forwarded hostnames can reach the API without
// hard‑coding the hostname.
const allowedOrigins = config.allowedOrigin === '*'
  ? '*'
  : config.allowedOrigin
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);

// Configure Socket.IO with CORS reflecting our allowed origins
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});

// -------------------------------------------------------------
// Global Middleware
// -------------------------------------------------------------

// Set various HTTP headers for security.  Configure a custom content security
// policy to permit our frontend to load assets from approved external CDNs and
// run inline scripts/styles.  Without these directives, Helmet’s default CSP
// would block the Tailwind CDN and inline scripts in index.html, causing
// requests to be blocked (see DevTools network panel for "blocked:csp").  We
// explicitly allow the Tailwind CDN and Google Fonts, enable inline scripts and
// styles (required for the client’s inline JavaScript and styling), and
// specify our own server for WebSocket connections.  If you add additional
// external resources, update these lists accordingly.
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // Permit scripts and default resources from our own domain and the
        // Tailwind CDN.  'unsafe-inline' is necessary for inline <script> tags
        // in index.html.  The socket.io client script is served from our
        // server under /socket.io/socket.io.js, so it is covered by 'self'.
        'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
        // Allow styles from self, inline <style> tags, Tailwind CDN and Google Fonts.
        'style-src': ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://fonts.googleapis.com'],
        // Permit fonts from self and Google Fonts CDN.  Without this the
        // Inter font will be blocked.
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        // Allow images from self as well as data and blob URIs (used by
        // screenshots/artifacts).  Adjust if you embed other external images.
        'img-src': ["'self'", 'data:', 'blob:'],
        // Specify where connections (XHR/WebSocket) can be made.  We allow our
        // own server and WebSocket endpoint.  Socket.IO will use these to
        // communicate between the front‑end and back‑end.
        'connect-src': (() => {
          if (allowedOrigins === '*') {
            return ["'self'", '*'];
          }

          const connectSources = allowedOrigins
            .flatMap((origin) => {
              try {
                const parsed = new URL(origin);
                const wsScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
                return [origin, `${wsScheme}//${parsed.host}`];
              } catch (err) {
                // If the origin cannot be parsed as a URL, fall back to the raw value
                return [origin];
              }
            })
            .filter(Boolean);

          // Ensure we always allow connections back to the served domain
          return Array.from(new Set(["'self'", ...connectSources]));
        })(),
        // Default fallback for other resource types.
        'default-src': ["'self'"],
      },
    },
  }),
);

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
      if (!origin || allowedOrigins === '*') return callback(null, true);
      return allowedOrigins.includes(origin) ? callback(null, true) : callback(new Error('Not allowed by CORS'));
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

// -------------------------------------------------------------
// Special Routes
// -------------------------------------------------------------

// Chrome DevTools in recent versions issues a request for
// `/.well-known/appspecific/com.chrome.devtools.json` when you open
// DevTools on a page served via localhost.  This file is optional and
// used to discover certain debugging features.  Our application does not
// provide it, but to prevent unnecessary stack traces in the logs we
// respond with 204 (No Content) instead of letting the 404 handler run.
app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.status(204).end();
});

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