import test from 'node:test';
import assert from 'node:assert/strict';
import { McpConnection } from '../src/mcp/client.js';

test('MCP call errors include recent server stderr diagnostics', async () => {
  const connection = new McpConnection('ltx-video', { command: 'python' });
  connection.connect = async () => connection;
  connection.client = {
    callTool: async () => {
      throw new Error('Connection closed');
    },
  };
  connection.stderr = 'RuntimeError: model inference failed';

  await assert.rejects(
    connection.call('ltx_video_generate'),
    /Connection closed[\s\S]*RuntimeError: model inference failed/,
  );
});

test('MCP call preserves the original error when no server diagnostics exist', async () => {
  const connection = new McpConnection('ltx-video', { command: 'python' });
  connection.connect = async () => connection;
  const failure = new Error('Connection closed');
  connection.client = { callTool: async () => { throw failure; } };

  await assert.rejects(connection.call('ltx_video_generate'), (error) => error === failure);
});
