const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { saveMessage, getRecentMessages, addAdminUser, verifyAdminUser, getAllAdminUsers } = require('./db');

// Middleware for parsing JSON
app.use(express.json());

// Store active sessions
const activeSessions = new Map();
// Store typing users
const typingUsers = new Set();

// Serve static files from public directory
app.use(express.static('public'));

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Serve admin page
app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
});

// API endpoint to add admin user
app.post('/api/admin/add', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }
        await addAdminUser(username, password);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add admin user' });
    }
});

// API endpoint to list admin users
app.get('/api/admin/list', async (req, res) => {
    try {
        const admins = await getAllAdminUsers();
        res.json(admins);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get admin users' });
    }
});

// Socket.IO connection handling
io.on('connection', async (socket) => {
    console.log('A user connected');

    // Send recent messages to newly connected user
    try {
        const recentMessages = await getRecentMessages();
        socket.emit('load messages', recentMessages);
    } catch (err) {
        console.error('Error loading messages:', err);
    }

    // Handle username and password verification
    socket.on('verify user', async (data) => {
        try {
            const { username, password } = data;
            const admin = await verifyAdminUser(username, password);
            
            if (admin) {
                // Check if user is already logged in
                if (activeSessions.has(username)) {
                    // Disconnect the previous session
                    const previousSocket = activeSessions.get(username);
                    if (previousSocket && previousSocket.id !== socket.id) {
                        previousSocket.emit('force logout', 'You have been logged out because you logged in from another location');
                        previousSocket.disconnect(true);
                    }
                }

                // Store the new session
                activeSessions.set(username, socket);
                socket.username = username;
                socket.isAdmin = true;

                // Notify everyone that a user has joined
                io.emit('user joined', username);
                console.log(`Admin ${username} joined the chat`);
            } else {
                socket.emit('auth error', 'Invalid username or password');
            }
        } catch (err) {
            console.error('Error verifying user:', err);
            socket.emit('auth error', 'Error verifying user');
        }
    });

    // Handle chat message
    socket.on('chat message', async (msg) => {
        if (socket.username && msg && msg.trim() !== '') {
            const messageData = {
                username: socket.username,
                message: msg.trim(),
                timestamp: new Date().toISOString(),
                seen: false,
                messageId: Date.now().toString() // Add unique message ID
            };

            try {
                // Save message to database
                await saveMessage(socket.username, msg.trim());
                // Broadcast message to all clients
                io.emit('chat message', messageData);
                console.log(`Message from ${socket.username}: ${msg}`);
            } catch (err) {
                console.error('Error saving message:', err);
                socket.emit('error', 'Failed to save message');
            }
        }
    });

    // Handle message seen
    socket.on('message seen', (messageId) => {
        if (socket.username) {
            io.emit('message seen', {
                messageId: messageId,
                seenBy: socket.username,
                timestamp: new Date().toISOString()
            });
        }
    });

    // Handle typing indicator
    socket.on('typing', (isTyping) => {
        if (socket.username) {
            if (isTyping) {
                typingUsers.add(socket.username);
            } else {
                typingUsers.delete(socket.username);
            }
            // Broadcast typing status to all clients except sender
            socket.broadcast.emit('typing status', {
                username: socket.username,
                isTyping: isTyping,
                typingUsers: Array.from(typingUsers)
            });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        if (socket.username) {
            // Remove from active sessions
            if (activeSessions.get(socket.username)?.id === socket.id) {
                activeSessions.delete(socket.username);
            }
            // Remove from typing users
            typingUsers.delete(socket.username);
            // Notify everyone that a user has left
            io.emit('user left', socket.username);
            // Update typing status for remaining users
            socket.broadcast.emit('typing status', {
                username: socket.username,
                isTyping: false,
                typingUsers: Array.from(typingUsers)
            });
            console.log(`User ${socket.username} disconnected`);
        }
    });
});

// Start the server
const PORT = process.env.PORT || 3002;
http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
}); 