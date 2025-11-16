import express, { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from './server.js'; 
import path from 'path';

const app = express();
app.use(express.json());
const server = createServer();

// Handle POST requests for client-to-server communication (stateless mode)
app.post('/mcp', async (req, res) => {
  // In stateless mode, create a new instance of transport and server for each request
  // to ensure complete isolation. A single instance would cause request ID collisions
  // when multiple clients connect concurrently.

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
      enableJsonResponse: true,
    });

    res.on('close', () => {
      console.log('Request closed');
      transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// SSE notifications not supported in stateless mode
app.get('/mcp', async (req, res) => {
  console.log('Received GET MCP request');
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  }));
});

// Session termination not needed in stateless mode
app.delete('/mcp', async (req, res) => {
  console.log('Received DELETE MCP request');
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  }));
});

app.get('/authcomplete', (_req: Request, res: Response) => {
    const fileUrl = new URL(import.meta.url);
    const __dirname = path.dirname(fileUrl.pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
    const filePath = path.resolve(__dirname, '..', 'authcomplete.html');
    res.sendFile(filePath);
});

// Start the server

const PORT = process.env.PORT || 3000;
app.listen(PORT, (error?: Error) => {
  if (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
  console.log(`Weather MCP Stateless HTTP Server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});


// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  server.close();
  process.exit(0);
});