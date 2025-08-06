// server.js (v1.4)
// Now with persistent drawing history for the infinite canvas.

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = 8080;
const wss = new WebSocket.Server({ port: PORT });

// We use a Map to store client data (ws object -> user info).
const clients = new Map();

// A list of distinct, pleasant colors to assign to new users.
const userColors = [
    '#E57373', '#81C784', '#64B5F6', '#FFD54F', '#BA68C8',
    '#4DB6AC', '#F06292', '#7986CB', '#A1887F', '#90A4AE'
];

// NEW: Store all drawing actions in memory.
const drawingHistory = [];

function broadcast(message, senderId) {
    clients.forEach((clientInfo, ws) => {
        // We check if the client's connection is open and if they are not the original sender.
        if (ws.readyState === WebSocket.OPEN && clientInfo.id !== senderId) {
            ws.send(JSON.stringify(message));
        }
    });
}

wss.on('connection', (ws) => {
    // 1. Assign unique ID and a color to the new client upon initial connection.
    const id = uuidv4();
    const color = userColors[clients.size % userColors.length];
    const metadata = { id, color, username: 'Anonymous' };
    
    clients.set(ws, metadata);
    console.log(`[Server] New client connected. Assigned ID: ${id}. Total clients: ${clients.size}`);

    // 2. Handle incoming messages with a simple routing logic based on message type.
    ws.on('message', (rawMessage) => {
        const message = JSON.parse(rawMessage);
        const senderInfo = clients.get(ws);

        switch (message.type) {
            // Case A: Client sends their username upon joining.
            case 'login':
                senderInfo.username = message.username;
                console.log(`[Server] Client ${senderInfo.id} set username to: ${senderInfo.username}`);

                // Send a "welcome" package to the new user with their info,
                // a list of everyone else, and the entire drawing history.
                ws.send(JSON.stringify({
                    type: 'welcome',
                    user: senderInfo,
                    allUsers: Array.from(clients.values()),
                    drawingHistory: drawingHistory // <-- SEND THE COMPLETE HISTORY
                }));

                // Announce the new user to all other clients.
                broadcast({
                    type: 'user-joined',
                    user: senderInfo,
                }, senderInfo.id);
                break;
            
            // Case B: Client sends drawing data.
            case 'draw':
                // Add the new drawing action to history for future users.
                drawingHistory.push(message);
                // Broadcast the drawing data to other currently connected clients.
                broadcast(message, senderInfo.id);
                break;
            
            // Case C: Client sends their cursor position.
            case 'cursor-move':
                // Broadcast cursor position, attaching the sender's ID.
                broadcast({
                    type: 'cursor-move',
                    id: senderInfo.id,
                    payload: message.payload
                }, senderInfo.id);
                break;
        }
    });

    // 3. Handle client disconnection.
    ws.on('close', () => {
        const closedClientInfo = clients.get(ws);
        if (closedClientInfo) {
            console.log(`[Server] Client ${closedClientInfo.id} (${closedClientInfo.username}) disconnected.`);
            // Announce that the user has left to all remaining clients so they can be removed.
            broadcast({
                type: 'user-left',
                id: closedClientInfo.id
            }, null); // Send to everyone, including a potential sender if needed.
        }
        clients.delete(ws); // Remove the client from our active list.
    });

    ws.on('error', (error) => {
        console.error('[Server] WebSocket error:', error);
    });
});

console.log(`[Server] WebSocket server v1.4 (Infinite Canvas) started on port ${PORT}`);