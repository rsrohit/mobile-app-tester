// Import necessary modules
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require("socket.io");
const apiRoutes = require('./api/routes');

// --- Basic Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for simplicity. In production, restrict this.
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// --- Middleware ---
// To parse JSON bodies
app.use(express.json());
// To parse URL-encoded bodies
app.use(express.urlencoded({ extended: true }));

// Serve the frontend UI
// This assumes the 'frontend' directory is two levels above the 'src' directory
// CORRECTED PATH: Changed from '../../../frontend' to '../../frontend'
const frontendPath = path.join(__dirname, '../../frontend');
app.use(express.static(frontendPath));

// --- API Routes ---
// Pass the 'io' instance to the routes so they can emit events
app.use('/api', apiRoutes(io));

// --- WebSocket Connection Handling ---
io.on('connection', (socket) => {
    console.log(`A user connected with socket id: ${socket.id}`);

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`User with socket id: ${socket.id} disconnected`);
    });

    // You can add more socket event listeners here if needed
});

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Frontend served from: ${frontendPath}`); // Added for debugging
});
