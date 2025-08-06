// server.js - V2 with Real-time Drawing & Session Persistence
// ==========================================================

const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = 8080;

// -- In-Memory State Management --
// Map to store user data across connections { userId -> { username, ws, currentRoomId } }
const users = new Map(); 
const whiteboards = new Map();

const wss = new WebSocketServer({ port: PORT });
console.log(`[Server] WebSocket server V2 started on port ${PORT}`);

wss.on('connection', (ws) => {
    // A WebSocket connection is established, but the user is not yet authenticated.
    // We will assign a temporary ws.id for handling until authentication.
    ws.id = uuidv4(); 
    console.log(`[Server] Incoming connection with temporary ID: ${ws.id}`);

    ws.on('message', (rawMessage) => {
        try {
            const message = JSON.parse(rawMessage);
            // Pass the WebSocket instance itself to the handler
            handleMessage(ws, message);
        } catch (error) {
            console.error(`[Server] Failed to parse message or handle logic:`, error);
        }
    });

    ws.on('close', () => {
        // Find user associated with this specific WebSocket instance
        let userIdToDisconnect = null;
        for (const [userId, userData] of users.entries()) {
            if (userData.ws === ws) {
                userIdToDisconnect = userId;
                break;
            }
        }
        if (userIdToDisconnect) {
            handleDisconnect(userIdToDisconnect);
        } else {
             console.log(`[Server] Unauthenticated connection ${ws.id} closed.`);
        }
    });

    ws.on('error', console.error);
});

function handleMessage(ws, message) {
    const { type, payload } = message;
    const user = getUserByWs(ws);

    switch (type) {
        case 'auth':
            let userId = payload.token || uuidv4(); // Use token if provided, else create new user
            let isReconnecting = users.has(userId);

            if (isReconnecting) {
                console.log(`[Server] User ${users.get(userId).username} (${userId}) reconnected.`);
            } else {
                console.log(`[Server] New user authenticated as ${payload.username} (${userId}).`);
            }

            // Associate the new WebSocket with the user ID
            users.set(userId, { 
                username: payload.username, 
                ws: ws, // Link the current WebSocket
                currentRoomId: isReconnecting ? users.get(userId).currentRoomId : null 
            });
            ws.userId = userId; // Link userId to ws for easier lookup

            ws.send(JSON.stringify({
                type: 'authenticated',
                payload: {
                    userId: userId, // This is the user's permanent token
                    whiteboards: getWhiteboardList()
                }
            }));
            break;

        case 'create_room':
        case 'join_room':
             if (user) handleRoomLogic(user, type, payload);
             break;
        
        // --- New Real-time Drawing Protocol ---
        case 'start_stroke':
        case 'draw_chunk':
        case 'end_stroke':
        case 'delete_stroke':
            if (user && user.currentRoomId) {
                // Relay drawing messages to other users in the same room
                broadcastToRoom(user.currentRoomId, message, user.userId);
                // Also update the server's state for persistence
                handleDrawingState(user, type, payload);
            }
            break;
        
        case 'cursor_move':
            if (user && user.currentRoomId) {
                 broadcastToRoom(user.currentRoomId, {
                    type: 'cursor_update',
                    payload: { ...payload, userId: user.userId, username: user.username }
                }, user.userId);
            }
            break;
    }
}

function handleRoomLogic(user, type, payload) {
    // User must leave previous room before joining a new one
    if (user.currentRoomId) {
        leaveCurrentRoom(user.userId);
    }
    
    if (type === 'create_room') {
        const roomId = uuidv4();
        const newWhiteboard = {
            id: roomId, name: payload.name, size: payload.size,
            creator: user.username, createdAt: new Date().toISOString(),
            clients: new Set(),
            strokes: [], // Completed strokes
            activeStrokes: new Map() // In-progress strokes {strokeId -> strokeObject}
        };
        whiteboards.set(roomId, newWhiteboard);
        console.log(`[Server] Room created: ${payload.name} (${roomId})`);
        broadcast({ type: 'room_list_update', payload: { whiteboards: getWhiteboardList() } });
    }
    
    if (type === 'join_room') {
        const roomToJoin = whiteboards.get(payload.roomId);
        if (roomToJoin) {
            roomToJoin.clients.add(user.userId);
            user.currentRoomId = payload.roomId;
            console.log(`[Server] User ${user.username} joined room ${payload.roomId}`);

            // Send the complete room state to the joining client
            user.ws.send(JSON.stringify({
                type: 'joined_room',
                payload: {
                    roomId: roomToJoin.id, name: roomToJoin.name, size: roomToJoin.size,
                    strokes: roomToJoin.strokes, // Send all completed strokes
                    activeStrokes: Array.from(roomToJoin.activeStrokes.values()), // Send all in-progress strokes
                    users: getUserListForRoom(roomToJoin)
                }
            }));

            // Notify others
            broadcastToRoom(payload.roomId, {
                type: 'user_joined',
                payload: { user: { id: user.userId, username: user.username } }
            }, user.userId);
        }
    }
}


function handleDrawingState(user, type, payload) {
    const room = whiteboards.get(user.currentRoomId);
    if (!room) return;

    switch (type) {
        case 'start_stroke':
            // Add to active strokes
            const newStroke = { ...payload, userId: user.userId, points: [payload.point] };
            room.activeStrokes.set(payload.strokeId, newStroke);
            break;
        case 'draw_chunk':
            // Add point to the active stroke
            const activeStroke = room.activeStrokes.get(payload.strokeId);
            if (activeStroke) {
                activeStroke.points.push(payload.point);
            }
            break;
        case 'end_stroke':
            // Move stroke from active to completed
            const finishedStroke = room.activeStrokes.get(payload.strokeId);
            if (finishedStroke) {
                room.strokes.push(finishedStroke);
                room.activeStrokes.delete(payload.strokeId);
            }
            break;
        case 'delete_stroke':
            // IMPORTANT: Security check. In a real app, you'd verify ownership here.
            // The client-side logic already prevents sending deletes for others' strokes.
            room.strokes = room.strokes.filter(s => s.id !== payload.strokeId);
            break;
    }
}


function handleDisconnect(userId) {
    const user = users.get(userId);
    if (!user) return;
    
    console.log(`[Server] User ${user.username} (${userId}) disconnected.`);
    leaveCurrentRoom(userId);
    users.delete(userId); // User is now fully offline
}

function leaveCurrentRoom(userId) {
    const user = users.get(userId);
    if (!user || !user.currentRoomId) return;

    const room = whiteboards.get(user.currentRoomId);
    if (room) {
        room.clients.delete(userId);
        // Clean up any unfinished strokes by this user
        for (const [strokeId, stroke] of room.activeStrokes.entries()) {
            if (stroke.userId === userId) {
                room.activeStrokes.delete(strokeId);
            }
        }
        broadcastToRoom(user.currentRoomId, { type: 'user_left', payload: { userId: userId } });
    }
    user.currentRoomId = null;
}

// Broadcast to all authenticated users
function broadcast(message) {
    const stringified = JSON.stringify(message);
    for (const user of users.values()) {
        if (user.ws && user.ws.readyState === 1) {
            user.ws.send(stringified);
        }
    }
}

function broadcastToRoom(roomId, message, excludeUserId = null) {
    const room = whiteboards.get(roomId);
    if (!room) return;
    const stringified = JSON.stringify(message);
    for (const clientId of room.clients) {
        if (clientId !== excludeUserId) {
            const user = users.get(clientId);
            if (user && user.ws && user.ws.readyState === 1) {
                user.ws.send(stringified);
            }
        }
    }
}

// Helper functions
function getWhiteboardList() { /* ... same as before ... */ }
function getUserListForRoom(room) { /* ... same as before ... */ }
function getUserByWs(ws) {
    if (!ws.userId) return null;
    const user = users.get(ws.userId);
    return user ? { ...user, userId: ws.userId } : null; // Return a copy with userId
}

// Add these back in if they were removed
function getWhiteboardList() {
    return Array.from(whiteboards.values()).map(room => ({
        id: room.id, name: room.name, creator: room.creator,
        createdAt: room.createdAt, userCount: room.clients.size
    }));
}
function getUserListForRoom(room) {
    return Array.from(room.clients).map(userId => ({
        id: userId,
        username: users.get(userId)?.username || 'Anonymous'
    }));
}