// server.js
// Backend for the Real-Time Collaborative Whiteboard
// Author: Gemini, Full-Stack Software Architect

const WebSocket = require('ws');

// Define the port for the WebSocket server. 
// You can change this, but make sure your reverse proxy (e.g., Nginx) points to this port.
const PORT = 8080;

// Create a new WebSocket server instance.
const wss = new WebSocket.Server({ port: PORT });

// A Set to store all connected clients. Sets are efficient for adding/deleting.
const clients = new Set();

// Event listener for new connections.
// The 'ws' object here represents the individual connection to a single client.
wss.on('connection', (ws) => {
    // Add the new client to our set of connected clients.
    clients.add(ws);
    console.log(`[Server] New client connected. Total clients: ${clients.size}`);

    // Event listener for messages from this client.
    ws.on('message', (message) => {
        // We expect the message to be a stringified JSON object.
        // We log the raw message for debugging purposes.
        console.log('[Server] Received message =>', message.toString());

        // Broadcast the received message to all other connected clients.
        // We iterate through every client in our 'clients' set.
        clients.forEach((client) => {
            // We only send to clients that are not the original sender and are ready to receive messages.
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message.toString());
            }
        });
    });

    // Event listener for when a client connection is closed.
    ws.on('close', () => {
        // Remove the client from our set.
        clients.delete(ws);
        console.log(`[Server] Client disconnected. Total clients: ${clients.size}`);
    });

    // Event listener for any errors that occur on the connection.
    ws.on('error', (error) => {
        console.error('[Server] WebSocket error:', error);
    });
});

console.log(`[Server] WebSocket server started on port ${PORT}`);
