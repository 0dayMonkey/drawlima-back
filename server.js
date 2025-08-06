// server.js - Real-time Whiteboard Backend
// ==========================================

const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

// -- Configuration --
const PORT = 8080; // The port your WebSocket server will run on.

// -- In-Memory State Management --
// We don't use a database. All data is stored in these objects.
// If the server restarts, all drawings will be lost.
const clients = new Map(); // Stores connected clients: { ws.id -> { ws, username, currentRoomId } }
const whiteboards = new Map(); // Stores whiteboard rooms: { roomId -> { ...roomData } }

// -- Server Initialization --
const wss = new WebSocketServer({ port: PORT });
console.log(`[Server] WebSocket server started on port ${PORT}`);

wss.on('connection', (ws) => {
    // 1. Assign a unique ID to the new client upon connection.
    ws.id = uuidv4();
    console.log(`[Server] Client connected with ID: ${ws.id}`);

    // 2. Handle incoming messages from the client.
    ws.on('message', (rawMessage) => {
        try {
            const message = JSON.parse(rawMessage);
            handleMessage(ws, message);
        } catch (error) {
            console.error(`[Server] Failed to parse message or handle logic:`, error);
        }
    });

    // 3. Handle client disconnection.
    ws.on('close', () => {
        handleDisconnect(ws);
    });

    ws.on('error', (error) => {
        console.error(`[Server] WebSocket error for client ${ws.id}:`, error);
    });
});

// -- Core Message Handler --
function handleMessage(ws, message) {
    const { type, payload } = message;
    // console.log(`[Server] Received message of type "${type}" from ${ws.id}`);

    switch (type) {
        case 'auth':
            // Client sends their desired username.
            clients.set(ws.id, { ws, username: payload.username, currentRoomId: null });
            ws.send(JSON.stringify({
                type: 'authenticated',
                payload: {
                    userId: ws.id,
                    whiteboards: getWhiteboardList()
                }
            }));
            break;

        case 'create_room':
            // Client wants to create a new whiteboard.
            const roomId = uuidv4();
            const newWhiteboard = {
                id: roomId,
                name: payload.name,
                size: payload.size, // e.g., { width: 1000, height: 1000 }
                creator: clients.get(ws.id).username,
                createdAt: new Date().toISOString(),
                clients: new Set(),
                strokes: [],
                userCursors: new Map() // { userId -> { x, y, username, color } }
            };
            whiteboards.set(roomId, newWhiteboard);
            console.log(`[Server] Room created: ${payload.name} (${roomId})`);
            // Notify all clients (even those in the lobby) about the new room.
            broadcast({
                type: 'room_list_update',
                payload: { whiteboards: getWhiteboardList() }
            });
            break;

        case 'join_room':
            // Client wants to join an existing whiteboard.
            leaveCurrentRoom(ws); // Ensure user leaves any previous room.

            const roomToJoin = whiteboards.get(payload.roomId);
            const clientData = clients.get(ws.id);
            if (roomToJoin && clientData) {
                roomToJoin.clients.add(ws.id);
                clientData.currentRoomId = payload.roomId;
                console.log(`[Server] Client ${ws.id} (${clientData.username}) joined room ${payload.roomId}`);

                // Send the complete room state to the joining client.
                ws.send(JSON.stringify({
                    type: 'joined_room',
                    payload: {
                        roomId: roomToJoin.id,
                        name: roomToJoin.name,
                        size: roomToJoin.size,
                        strokes: roomToJoin.strokes,
                        users: getUserListForRoom(roomToJoin)
                    }
                }));

                // Notify other clients in the room about the new user.
                broadcastToRoom(payload.roomId, {
                    type: 'user_joined',
                    payload: { user: { id: ws.id, username: clientData.username } }
                }, ws.id);
            }
            break;

        case 'draw_stroke':
             // Client sends a new drawing stroke.
            const clientInRoom = clients.get(ws.id);
            if (clientInRoom && clientInRoom.currentRoomId) {
                const room = whiteboards.get(clientInRoom.currentRoomId);
                if (room) {
                    const stroke = { ...payload, id: uuidv4(), userId: ws.id };
                    room.strokes.push(stroke);
                    // Broadcast the new stroke to everyone else in the same room.
                    broadcastToRoom(clientInRoom.currentRoomId, {
                        type: 'new_stroke',
                        payload: stroke
                    }, ws.id); // Exclude the sender.
                }
            }
            break;
        
        case 'delete_stroke':
            // Client wants to delete a stroke they created.
            const clientDeleting = clients.get(ws.id);
            if(clientDeleting && clientDeleting.currentRoomId) {
                const room = whiteboards.get(clientDeleting.currentRoomId);
                if(room) {
                    const strokeToDelete = room.strokes.find(s => s.id === payload.strokeId);
                    // IMPORTANT: Security check. Only the user who created the stroke can delete it.
                    if (strokeToDelete && strokeToDelete.userId === ws.id) {
                        room.strokes = room.strokes.filter(s => s.id !== payload.strokeId);
                         // Notify all clients in the room to remove the stroke.
                        broadcastToRoom(clientDeleting.currentRoomId, {
                            type: 'stroke_deleted',
                            payload: { strokeId: payload.strokeId }
                        });
                    }
                }
            }
            break;

        case 'cursor_move':
            // Client sends their cursor position.
            const clientMoving = clients.get(ws.id);
            if (clientMoving && clientMoving.currentRoomId) {
                // This is a high-frequency event. We broadcast it directly.
                // We don't store it in the main state to avoid clutter,
                // but we could if we wanted to show cursors to newly joined users immediately.
                broadcastToRoom(clientMoving.currentRoomId, {
                    type: 'cursor_update',
                    payload: {
                        userId: ws.id,
                        username: clientMoving.username,
                        x: payload.x,
                        y: payload.y,
                        color: payload.color
                    }
                }, ws.id); // Exclude sender
            }
            break;
    }
}

// -- Helper Functions --

function handleDisconnect(ws) {
    console.log(`[Server] Client disconnected: ${ws.id}`);
    leaveCurrentRoom(ws);
    clients.delete(ws.id);
}

function leaveCurrentRoom(ws) {
    const clientData = clients.get(ws.id);
    if (!clientData || !clientData.currentRoomId) return;

    const room = whiteboards.get(clientData.currentRoomId);
    if (room) {
        console.log(`[Server] Client ${ws.id} leaving room ${clientData.currentRoomId}`);
        room.clients.delete(ws.id);
        // Notify others in the room that this user has left.
        broadcastToRoom(clientData.currentRoomId, {
            type: 'user_left',
            payload: { userId: ws.id, username: clientData.username }
        }, ws.id);
    }
    clientData.currentRoomId = null;
}

// Broadcast a message to all connected clients.
function broadcast(message) {
    const stringifiedMessage = JSON.stringify(message);
    for (const clientData of clients.values()) {
        clientData.ws.send(stringifiedMessage);
    }
}

// Broadcast a message to all clients in a specific room.
function broadcastToRoom(roomId, message, excludeClientId = null) {
    const room = whiteboards.get(roomId);
    if (!room) return;

    const stringifiedMessage = JSON.stringify(message);
    for (const clientId of room.clients) {
        if (clientId !== excludeClientId) {
            const clientData = clients.get(clientId);
            if (clientData) {
                clientData.ws.send(stringifiedMessage);
            }
        }
    }
}

// Get a simplified list of whiteboards for the lobby view.
function getWhiteboardList() {
    return Array.from(whiteboards.values()).map(room => ({
        id: room.id,
        name: room.name,
        creator: room.creator,
        createdAt: room.createdAt,
        userCount: room.clients.size
    }));
}

// Get a list of users currently in a room.
function getUserListForRoom(room) {
    const userList = [];
    for (const clientId of room.clients) {
        const clientData = clients.get(clientId);
        if (clientData) {
            userList.push({ id: clientData.ws.id, username: clientData.username });
        }
    }
    return userList;
}