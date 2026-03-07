const express = require('express');
const app = express();
const path = require('path'); // safer path handling
const bodyParser = require('body-parser');
const PORT = process.env.PORT || 8000;

// Import router
const codeRouter = require('./pair');

// Increase EventEmitter listeners (optional)
require('events').EventEmitter.defaultMaxListeners = 500;

// Body parser middleware (must be before routes)
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
app.use('/code', codeRouter); // Router from pair.js

app.use('/pair', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'pair.js')); // serve file safely
});

app.use('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'main.html')); // serve main page
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = app;
