import { createWebSocketServer } from './app';

const PORT = 3000;
const server = createWebSocketServer();

server.listen(PORT, () => {
    console.log(`⚡️[server]: Server is running at http://localhost:${PORT}`);
})