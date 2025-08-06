// server.js (v1.5)
// Avec persistance de la map sur fichier et fonctionnalité "Tout Effacer".

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs'); // NOUVEAU: Module pour gérer les fichiers

const PORT = 8080;
const MAP_FILE = './map.json'; // NOUVEAU: Fichier de sauvegarde de la map

const wss = new WebSocket.Server({ port: PORT });
const clients = new Map();
const userColors = [
    '#E57373', '#81C784', '#64B5F6', '#FFD54F', '#BA68C8',
    '#4DB6AC', '#F06292', '#7986CB', '#A1887F', '#90A4AE'
];

// NOUVEAU: Charger l'historique depuis le fichier au démarrage
let drawingHistory = [];
try {
    if (fs.existsSync(MAP_FILE)) {
        const fileData = fs.readFileSync(MAP_FILE, 'utf-8');
        drawingHistory = JSON.parse(fileData);
        console.log(`[Server] Map chargée depuis ${MAP_FILE}. ${drawingHistory.length} actions trouvées.`);
    }
} catch (error) {
    console.error('[Server] Erreur au chargement de la map:', error);
}

// NOUVEAU: Fonction pour sauvegarder la map
function saveMap() {
    fs.writeFile(MAP_FILE, JSON.stringify(drawingHistory, null, 2), (err) => {
        if (err) {
            console.error('[Server] Erreur lors de la sauvegarde de la map:', err);
        } else {
            console.log('[Server] Map sauvegardée avec succès.');
        }
    });
}

function broadcast(message) {
    clients.forEach((clientInfo, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
}

function broadcastToOthers(message, senderId) {
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

        switch (message.type) {
            case 'login':
                senderInfo.username = message.username;
                ws.send(JSON.stringify({
                    type: 'welcome',
                    user: senderInfo,
                    allUsers: Array.from(clients.values()),
                    drawingHistory: drawingHistory
                }));
                broadcastToOthers({ type: 'user-joined', user: senderInfo }, senderInfo.id);
                break;
            
            case 'draw':
                drawingHistory.push(message);
                broadcastToOthers(message, senderInfo.id);
                saveMap(); // Sauvegarder après chaque nouveau dessin
                break;
            
            case 'cursor-move':
                broadcastToOthers({ type: 'cursor-move', id: senderInfo.id, payload: message.payload }, senderInfo.id);
                break;

            // NOUVEAU: Gérer l'effacement complet
            case 'clear':
                drawingHistory.length = 0; // Vider l'historique
                broadcast({ type: 'clear' }); // Informer tous les clients
                saveMap(); // Sauvegarder la map vide
                console.log(`[Server] Map effacée par ${senderInfo.username}.`);
                break;
        }
    });

    ws.on('close', () => {
        const closedClientInfo = clients.get(ws);
        if (closedClientInfo) {
            broadcastToOthers({ type: 'user-left', id: closedClientInfo.id }, null);
        }
        clients.delete(ws);
    });

    ws.on('error', (error) => console.error('[Server] WebSocket error:', error));
});

console.log(`[Server] WebSocket server v1.5 (Persistance activée) démarré sur le port ${PORT}`);