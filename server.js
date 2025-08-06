// server.js (v1.4)
// Now with persistent drawing history for the infinite canvas.

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = 8080;
const wss = new WebSocket.Server({ port: PORT });

const clients = new Map();
const userColors = [
    '#E57373', '#81C784', '#64B5F6', '#FFD54F', '#BA68C8',
    '#4DB6AC', '#F06292', '#7986CB', '#A1887F', '#90A4AE'
];

// NEW: Store all drawing actions in memory.
const drawingHistory = [];

function broadcast(message, senderId) {
    clients.forEach((clientInfo, ws) => {
        if (ws.readyState === WebSocket.OPEN && clientInfo.id !== senderId) {
            ws.send(JSON.stringify(message));
        }
    });
}

wss.on('connection', (ws) => {
    const id = uuidv4();
    const color = userColors[clients.size % userColors.length];
    const metadata = { id, color, username: 'Anonymous' };
    
    clients.set(ws, metadata);
    console.log(`[Server] New client connected. Assigned ID: ${id}.`);

    ws.on('message', (rawMessage) => {
        const message = JSON.parse(rawMessage);
        const senderInfo = clients.get(ws);

        if (message.type === 'login') {
            senderInfo.username = message.username;
            console.log(`[Server] Client ${senderInfo.id} set username to: ${senderInfo.username}`);
            
            // Send welcome package including the entire drawing history.
            ws.send(JSON.stringify({
                type: 'welcome',
                user: senderInfo,
                allUsers: Array.from(clients.values()),
                drawingHistory: drawingHistory // <-- SEND HISTORY
            }));

            broadcast({ type: 'user-joined', user: senderInfo }, senderInfo.id);
        }
        
        else if (message.type === 'draw') {
            // Add the new drawing action to history and broadcast it.
            drawingHistory.push(message);
            broadcast(message, senderInfo.id);
        }
        
        else if (message.type === 'cursor-move') {
            broadcast({ type: 'cursor-move', id: senderInfo.id, payload: message.payload }, senderInfo.id);
        }
    });

    ws.on('close', () => {
        const closedClientInfo = clients.get(ws);
        if (closedClientInfo) {
            console.log(`[Server] Client ${closedClientInfo.id} (${closedClientInfo.username}) disconnected.`);
            broadcast({ type: 'user-left', id: closedClientInfo.id }, null);
        }
        clients.delete(ws);
    });

    ws.on('error', (error) => console.error('[Server] WebSocket error:', error));
});

console.log(`[Server] WebSocket server v1.4 (Infinite Canvas) started on port ${PORT}`);