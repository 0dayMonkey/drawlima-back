// server.js (v1.6)
// Gestion par "objets-traits" avec suppression sécurisée par propriétaire.

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const PORT = 8080;
const MAP_FILE = './map.json'; // Fichier de sauvegarde de la map

const wss = new WebSocket.Server({ port: PORT });
const clients = new Map();
const userColors = ['#E57373', '#81C784', '#64B5F6', '#FFD54F', '#BA68C8', '#4DB6AC', '#F06292', '#7986CB', '#A1887F', '#90A4AE'];

// Charger l'historique depuis le fichier au démarrage
let drawingHistory = [];
try {
    if (fs.existsSync(MAP_FILE)) {
        const fileData = fs.readFileSync(MAP_FILE, 'utf-8');
        drawingHistory = JSON.parse(fileData);
        console.log(`[Server] Map chargée depuis ${MAP_FILE}. ${drawingHistory.length} traits trouvés.`);
    }
} catch (error) {
    console.error('[Server] Erreur au chargement de la map:', error);
}

// Fonction pour sauvegarder la map de manière asynchrone
function saveMap() {
    fs.writeFile(MAP_FILE, JSON.stringify(drawingHistory, null, 2), (err) => {
        if (err) console.error('[Server] Erreur lors de la sauvegarde de la map:', err);
    });
}

// Envoyer un message à tous les clients connectés
function broadcast(message) {
    const data = JSON.stringify(message);
    clients.forEach((clientInfo, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });
}

wss.on('connection', (ws) => {
    const id = uuidv4();
    const color = userColors[clients.size % userColors.length];
    const metadata = { id, color, username: 'Anonymous' };
    
    clients.set(ws, metadata);
    console.log(`[Server] Client connecté: ${id}. Total: ${clients.size}`);

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
                broadcast({ type: 'user-joined', user: senderInfo });
                break;
            
            case 'add-stroke':
                const newStroke = message.stroke;
                newStroke.ownerId = senderInfo.id; // Sécurité: le serveur assigne le propriétaire
                drawingHistory.push(newStroke);
                broadcast({ type: 'add-stroke', stroke: newStroke });
                saveMap();
                break;

            case 'delete-stroke':
                const strokeIdToDelete = message.strokeId;
                const strokeIndex = drawingHistory.findIndex(s => s.strokeId === strokeIdToDelete);

                if (strokeIndex !== -1) {
                    if (drawingHistory[strokeIndex].ownerId === senderInfo.id) {
                        drawingHistory.splice(strokeIndex, 1);
                        broadcast({ type: 'delete-stroke', strokeId: strokeIdToDelete });
                        saveMap();
                        console.log(`[Server] Trait ${strokeIdToDelete} effacé par ${senderInfo.username}.`);
                    } else {
                        console.log(`[Server] ALERTE SECURITE: ${senderInfo.username} a tenté d'effacer un trait qui ne lui appartient pas.`);
                    }
                }
                break;
            
            case 'cursor-move':
                message.id = senderInfo.id;
                broadcast(message);
                break;
        }
    });

    ws.on('close', () => {
        const closedClientInfo = clients.get(ws);
        if (closedClientInfo) {
            broadcast({ type: 'user-left', id: closedClientInfo.id });
            console.log(`[Server] Client déconnecté: ${closedClientInfo.id}. Total: ${clients.size - 1}`);
        }
        clients.delete(ws);
    });
});

console.log(`[Server] WebSocket server v1.6 (Gestion par Objet) démarré sur le port ${PORT}`);