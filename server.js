// server.js (v1.1)
// Now with user state management for live cursors.

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = 8080;
const wss = new WebSocket.Server({ port: PORT });

// We now use a Map to store client data (ws object -> user info).
const clients = new Map();

// A list of distinct, pleasant colors to assign to new users.
const userColors = [
    '#E57373', '#81C784', '#64B5F6', '#FFD54F', '#BA68C8',
    '#4DB6AC', '#F06292', '#7986CB', '#A1887F', '#90A4AE'
];

function broadcast(message, senderId) {
    clients.forEach((clientInfo, ws) => {
        if (ws.readyState === WebSocket.OPEN && clientInfo.id !== senderId) {
            ws.send(JSON.stringify(message));
        }
    });
}

wss.on('connection', (ws) => {
    // 1. Assign unique ID and a color to the new client.
    const id = uuidv4();
    const color = userColors[clients.size % userColors.length];
    const metadata = { id, color, username: 'Anonymous' };
    
    clients.set(ws, metadata);
    console.log(`[Server] New client connected. Assigned ID: ${id}. Total clients: ${clients.size}`);

    // 2. Handle incoming messages with a simple routing logic.
    ws.on('message', (rawMessage) => {
        const message = JSON.parse(rawMessage);
        const senderInfo = clients.get(ws);

        // A. Client sends their username upon joining.
        if (message.type === 'login') {
            senderInfo.username = message.username;
            console.log(`[Server] Client ${senderInfo.id} set username to: ${senderInfo.username}`);

            // Send a "welcome" package to the new user with their info
            // and a list of everyone else already in the room.
            const allUsers = Array.from(clients.values());
            ws.send(JSON.stringify({
                type: 'welcome',
                user: senderInfo,
                allUsers: allUsers,
            }));

            // Announce the new user to all other clients.
            broadcast({
                type: 'user-joined',
                user: senderInfo,
            }, senderInfo.id);
        }
        
        // B. Client sends drawing data.
        else if (message.type === 'draw') {
            // Simply broadcast the drawing data to other clients.
            broadcast(message, senderInfo.id);
        }
        
        // C. Client sends their cursor position.
        else if (message.type === 'cursor-move') {
            // Broadcast cursor position, attaching the sender's ID.
            broadcast({
                type: 'cursor-move',
                id: senderInfo.id,
                payload: message.payload
            }, senderInfo.id);
        }
    });

    // 3. Handle disconnection.
    ws.on('close', () => {
        const closedClientInfo = clients.get(ws);
        if (closedClientInfo) {
            console.log(`[Server] Client ${closedClientInfo.id} (${closedClientInfo.username}) disconnected.`);
            // Announce that the user has left to all remaining clients.
            broadcast({
                type: 'user-left',
                id: closedClientInfo.id
            }, null); // Send to everyone.
        }
        clients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('[Server] WebSocket error:', error);
    });
});

console.log(`[Server] WebSocket server v1.1 started on port ${PORT}`);