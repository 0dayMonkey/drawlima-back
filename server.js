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

    // All drawing and room logic requires an authenticated user
    if (!user && type !== 'auth') {
        console.warn(`[Server] Received message of type '${type}' from unauthenticated client. Ignoring.`);
        return;
    }

    switch (type) {
        case 'auth':
            let userId = payload.token || uuidv4(); // Use token if provided, else create new user
            let isReconnecting = users.has(userId);

            const oldWs = isReconnecting ? users.get(userId).ws : null;
            if (oldWs && oldWs !== ws) {
                console.log(`[Server] Terminating old connection for user ${payload.username}.`);
                oldWs.terminate();
            }

            if (isReconnecting) {
                console.log(`[Server] User ${users.get(userId).username} (${userId}) reconnected.`);
            } else {
                console.log(`[Server] New user authenticated as ${payload.username} (${userId}).`);
            }

            users.set(userId, { 
                username: payload.username, 
                ws: ws,
                currentRoomId: isReconnecting ? users.get(userId).currentRoomId : null 
            });
            ws.userId = userId;

            ws.send(JSON.stringify({
                type: 'authenticated',
                payload: {
                    userId: userId,
                    whiteboards: getWhiteboardList()
                }
            }));
            break;

        case 'create_room':
        case 'join_room':
             handleRoomLogic(user, type, payload);
             break;
        
        case 'start_stroke':
        case 'draw_chunk':
        case 'end_stroke':
        case 'delete_stroke':
            if (user.currentRoomId) {
                // First, broadcast the message to everyone else in the room
                broadcastToRoom(user.currentRoomId, message, user.userId);
                // Then, update the server's state for persistence
                handleDrawingState(user, type, payload);
            }
            break;
        
        case 'cursor_move':
            if (user.currentRoomId) {
                 broadcastToRoom(user.currentRoomId, {
                    type: 'cursor_update',
                    payload: { ...payload, userId: user.userId, username: user.username }
                }, user.userId);
            }
            break;
    }
}

function handleRoomLogic(user, type, payload) {
    if (user.currentRoomId) {
        leaveCurrentRoom(user.userId);
    }
    
    let roomToJoinId = null;

    if (type === 'create_room') {
        const roomId = uuidv4();
        const newWhiteboard = {
            id: roomId, name: payload.name, size: payload.size,
            creator: user.username, createdAt: new Date().toISOString(),
            clients: new Set(),
            strokes: [],
            activeStrokes: new Map()
        };
        whiteboards.set(roomId, newWhiteboard);
        console.log(`[Server] Room created: ${payload.name} (${roomId})`);
        broadcast({ type: 'room_list_update', payload: { whiteboards: getWhiteboardList() } });
        roomToJoinId = roomId; // Automatically join the room you create
    } else {
        roomToJoinId = payload.roomId;
    }
    
    const roomToJoin = whiteboards.get(roomToJoinId);
    if (roomToJoin) {
        roomToJoin.clients.add(user.userId);
        user.currentRoomId = roomToJoinId;
        console.log(`[Server] User ${user.username} joined room ${roomToJoin.name} (${roomToJoinId})`);

        user.ws.send(JSON.stringify({
            type: 'joined_room',
            payload: {
                roomId: roomToJoin.id, name: roomToJoin.name, size: roomToJoin.size,
                strokes: roomToJoin.strokes,
                activeStrokes: Array.from(roomToJoin.activeStrokes.values()),
                users: getUserListForRoom(roomToJoin)
            }
        }));

        broadcastToRoom(roomToJoinId, {
            type: 'user_joined',
            payload: { user: { id: user.userId, username: user.username } }
        }, user.userId);
    }
}


function handleDrawingState(user, type, payload) {
    const room = whiteboards.get(user.currentRoomId);
    if (!room) return;

    switch (type) {
        case 'start_stroke':
            // CORRECTED: The payload *is* the stroke object.
            // We just ensure the userId is the one from the authenticated user.
            const newStroke = { ...payload, userId: user.userId };
            room.activeStrokes.set(newStroke.id, newStroke);
            break;

        case 'draw_chunk':
            const activeStroke = room.activeStrokes.get(payload.strokeId);
            if (activeStroke) {
                activeStroke.points.push(payload.point);
            }
            break;

        case 'end_stroke':
            const finishedStroke = room.activeStrokes.get(payload.strokeId);
            if (finishedStroke) {
                room.strokes.push(finishedStroke);
                room.activeStrokes.delete(payload.strokeId);
            }
            break;
            
        case 'delete_stroke':
            // The client-side logic should prevent sending deletes for others' strokes,
            // but we can add a server-side check for security.
            const originalStrokeIndex = room.strokes.findIndex(s => s.id === payload.strokeId);
            if (originalStrokeIndex !== -1 && room.strokes[originalStrokeIndex].userId === user.userId) {
                 room.strokes.splice(originalStrokeIndex, 1);
            }
            break;
    }
}


function handleDisconnect(userId) {
    const user = users.get(userId);
    if (!user) return;
    
    console.log(`[Server] User ${user.username} (${userId}) disconnected.`);
    leaveCurrentRoom(userId);
    users.delete(userId);
}

function leaveCurrentRoom(userId) {
    const user = users.get(userId);
    if (!user || !user.currentRoomId) return;

    const roomId = user.currentRoomId;
    const room = whiteboards.get(roomId);

    if (room) {
        room.clients.delete(userId);
        console.log(`[Server] User ${user.username} left room ${room.name}`);

        for (const [strokeId, stroke] of room.activeStrokes.entries()) {
            if (stroke.userId === userId) {
                room.activeStrokes.delete(strokeId);
            }
        }
        broadcastToRoom(roomId, { type: 'user_left', payload: { userId: userId } });
        
        // If the room is empty, consider deleting it after a timeout
        if (room.clients.size === 0) {
            console.log(`[Server] Room ${room.name} is now empty. It will be deleted in 60 seconds if no one rejoins.`);
            setTimeout(() => {
                const potentiallyEmptyRoom = whiteboards.get(roomId);
                if (potentiallyEmptyRoom && potentiallyEmptyRoom.clients.size === 0) {
                    whiteboards.delete(roomId);
                    console.log(`[Server] Deleted empty room ${room.name} (${roomId})`);
                    broadcast({ type: 'room_list_update', payload: { whiteboards: getWhiteboardList() } });
                }
            }, 60000); // 60-second grace period
        }
    }
    user.currentRoomId = null;
}

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

function getUserByWs(ws) {
    if (!ws.userId) return null;
    const user = users.get(ws.userId);
    return user ? { ...user, userId: ws.userId } : null;
}

function getWhiteboardList() {
    return Array.from(whiteboards.values()).map(room => ({
        id: room.id, name: room.name, creator: room.creator,
        createdAt: room.createdAt, userCount: room.clients.size
    }));
}

function getUserListForRoom(room) {
    return Array.from(room.clients).map(userId => {
        const user = users.get(userId);
        return {
            id: userId,
            username: user ? user.username : 'Anonymous'
        };
    });
}