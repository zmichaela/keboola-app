// server.js
import express from 'express';
const app = express();
const PORT = process.env.PORT || 3000;

app.all('/', (req, res) => {          // app.all handles both GET and POST
    res.send('<h1>Hello from Keboola!</h1>');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`App running on port ${PORT}`);
});
