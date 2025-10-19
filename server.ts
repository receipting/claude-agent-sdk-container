import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { getCookie, setCookie } from "hono/cookie";
import { SignJWT, jwtVerify } from "jose";
import { githubAuth } from "@hono/oauth-providers/github";
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs";
import os from "os";
import path from "path";

// Environment setup
const SECRET = new TextEncoder().encode(process.env.SESSION_SECRET || "devdevdev");
const PORT = process.env.PORT || 8080;

// Auto-allow all tool uses (no permission prompts)
const allowAll: CanUseTool = async (_toolName, input) => ({
  behavior: 'allow',
  updatedInput: input,
});

// GitHub allowlist configuration
const allowedGithubUsers = process.env.ALLOWED_GITHUB_USERS?.split(',').map(u => u.trim().toLowerCase()) || [];
const allowedGithubOrg = process.env.ALLOWED_GITHUB_ORG?.trim().toLowerCase() || '';

// Check if running in Docker (skip check in test mode)
if (process.env.NODE_ENV !== 'test') {
  const isDocker = fs.existsSync('/.dockerenv') || process.env.container === 'docker';

  if (!isDocker && process.env.ALLOW_LOCAL !== 'true') {
    console.error("\n❌ ERROR: This application must be run in Docker!");
    console.error("\n📋 Quick Start:");
    console.error("1. Ensure Docker is running");
    console.error("2. Run the test script: ./test.sh");
    console.error("   (The script handles Docker build, run, and testing automatically)\n");
    console.error("To bypass this check (not recommended): ALLOW_LOCAL=true tsx server.ts\n");
    process.exit(1);
  }

  // Check GitHub allowlist configuration (required for security)
  if (allowedGithubUsers.length === 0 && !allowedGithubOrg) {
    console.error("\n❌ ERROR: GitHub access control must be configured!");
    console.error("\n🔐 Security Requirement:");
    console.error("You must configure at least one of these environment variables:");
    console.error("- ALLOWED_GITHUB_USERS=user1,user2,user3");
    console.error("- ALLOWED_GITHUB_ORG=yourcompany");
    console.error("\nThis prevents unauthorized access to your Claude instance.\n");
    process.exit(1);
  }
}

// GitHub user validation function
function isGithubUserAllowed(githubUser: any): boolean {
  if (!githubUser?.login) return false;

  const username = githubUser.login.toLowerCase();

  // Check username allowlist
  if (allowedGithubUsers.length > 0 && allowedGithubUsers.includes(username)) {
    return true;
  }

  // Check organization membership (this would need GitHub API call in production)
  // For now, we'll just check if the user belongs to allowed org via their company field
  if (allowedGithubOrg && githubUser.company) {
    const userOrg = githubUser.company.toLowerCase().replace(/[@\s]/g, '');
    return userOrg.includes(allowedGithubOrg);
  }

  return false;
}


// JWT utilities
async function setSessionCookie(c: any, githubUser: any) {
  const token = await new SignJWT({
    sub: githubUser.login,
    username: githubUser.login,
    id: githubUser.id,
    email: githubUser.email,
    name: githubUser.name,
    avatar_url: githubUser.avatar_url
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime('3600s')
    .sign(SECRET);

  setCookie(c, 'sid', token, {
    path: "/",
    maxAge: 3600,
    httpOnly: true,
    secure: true,
    sameSite: "Lax"
  });
}

// API key auth helper
function checkApiAuth(c: any): boolean {
  const configuredKey = process.env.CLAUDE_AGENT_SDK_CONTAINER_API_KEY;
  if (!configuredKey) return true; // No key = public access

  const apiKey = c.req.header('x-api-key') || c.req.header('authorization')?.replace('Bearer ', '');
  return apiKey === configuredKey;
}

// WebSocket auth helper
async function checkWSAuth(c: any): Promise<boolean> {
  const val = getCookie(c, 'sid');
  if (!val) return false;
  try {
    await jwtVerify(val, SECRET);
    return true;
  } catch {
    return false;
  }
}

export const app = new Hono();

// WebSocket setup
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Session ID store (keyed by WebSocket connection)
// The Claude SDK returns a new session ID with each response that must be used to resume the conversation
const sessionIds = new Map<any, string>();

// Startup logging (skip in test mode)
if (process.env.NODE_ENV !== 'test') {
  const isDocker = fs.existsSync('/.dockerenv') || process.env.container === 'docker';
  console.log("Claude Agent SDK Container starting...");
  console.log("Environment:", isDocker ? "Docker" : "Local");
  console.log("Anthropic API key:", !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) ? "✓" : "✗");
  console.log("API protection:", !!process.env.CLAUDE_AGENT_SDK_CONTAINER_API_KEY ? "✓" : "✗");
  console.log("GitHub OAuth:", !!process.env.GITHUB_CLIENT_ID && !!process.env.GITHUB_CLIENT_SECRET ? "✓" : "✗");
  if (allowedGithubUsers.length > 0) console.log("GitHub users allowlist:", allowedGithubUsers.length, "users");
  if (allowedGithubOrg) console.log("GitHub org restriction:", allowedGithubOrg);
}

// Health check endpoint
app.get("/health", (c) => {
  const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const sdkLoaded = typeof query === "function";

  return c.json({
    status: hasApiKey && sdkLoaded ? "healthy" : "unhealthy",
    hasApiKey,
    sdkLoaded,
    message: "Claude Agent SDK API with CLI",
    timestamp: new Date().toISOString(),
  });
});

// Serve React SPA at root for browser requests (skip in test mode)
if (process.env.NODE_ENV !== 'test') {
  app.get("/", serveStatic({
    root: './web/dist',
    path: './index.html'
  }));
}

// Legacy query endpoint (REST API with API key auth)
app.post("/query", async (c) => {
  try {
    // API key authentication
    if (!checkApiAuth(c)) {
      return c.json({ error: 'Unauthorized - Invalid or missing API key' }, 401);
    }

    const { prompt, options = {} } = await c.req.json();

    if (!prompt) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    if (typeof prompt !== 'string') {
      return c.json({ error: "Prompt must be a string" }, 400);
    }

    if (prompt.length > 100000) {
      return c.json({ error: 'Prompt too long. Maximum 100000 characters' }, 400);
    }

    if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return c.json({ error: "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN must be configured" }, 401);
    }

    const messages = [];
    let responseText = "";

    // Build options for REST API with multi-agent support
    const queryOptions: any = {
      model: options.model || 'claude-sonnet-4-5',
      agents: {
        canadian_agent: {
          description: "Provides a friendly Canadian perspective on the user's request",
          prompt: `You are a cheerful Canadian assistant, eh! Speak with Canadian character using expressions like "eh", "sorry", "beauty", "bud".
Be polite, friendly, optimistic, and inclusive. Give helpful advice with Canadian warmth and positivity.
Keep your responses concise (2-3 sentences) and always make it clear you're the Canadian perspective.`,
          model: 'sonnet' as const
        },
        australian_agent: {
          description: "Provides a laid-back Australian perspective on the user's request",
          prompt: `You are a relaxed Australian assistant, mate! Speak with Aussie character using expressions like "mate", "no worries", "she'll be right", "fair dinkum".
Be casual, easy-going, practical, and down-to-earth. Give straightforward advice with Australian laid-back charm.
Keep your responses concise (2-3 sentences) and always make it clear you're the Australian perspective.`,
          model: 'sonnet' as const
        }
      }
    };

    // Wrap user prompt to coordinate agent discussion
    const coordinatedPrompt = `The user has sent this request: "${prompt}"

Please coordinate with the canadian_agent and australian_agent subagents to discuss this request and provide their perspectives. Use the Task tool to ask each agent for their viewpoint, then synthesize their discussion into a helpful response for the user.

Format the response to show each agent's perspective clearly, then provide a summary.`;

    // Use the Claude Agent SDK for multi-agent discussion
    const response = query({
      prompt: coordinatedPrompt,
      options: queryOptions,
    });

    for await (const message of response) {
      messages.push(message);

      // For REST API, just collect assistant text responses
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === "text") {
            responseText += block.text;
          }
        }
      }
    }

    return c.json({
      success: true,
      response: responseText
    });
  } catch (error: any) {
    console.error("Query error:", error.message);
    return c.json({
      error: "Failed to process query",
      details: error.message,
    }, 500);
  }
});

// GitHub App configuration and setup
app.use('/auth/github', (c, next) => {
  // Detect protocol from standard headers used by proxies/load balancers
  const xForwardedProto = c.req.header('x-forwarded-proto');
  const xForwardedSsl = c.req.header('x-forwarded-ssl');
  const xUrlScheme = c.req.header('x-url-scheme');

  // Use HTTPS if any common proxy header indicates it
  const protocol = (
    xForwardedProto === 'https' ||
    xForwardedSsl === 'on' ||
    xUrlScheme === 'https' ||
    process.env.NODE_ENV === 'production'
  ) ? 'https' : 'http';

  const host = c.req.header('host') || 'localhost:8080';
  const redirectUri = `${protocol}://${host}/auth/github`;

  return githubAuth({
    client_id: process.env.GITHUB_CLIENT_ID!,
    client_secret: process.env.GITHUB_CLIENT_SECRET!,
    scope: ['read:user', 'user:email'],
    redirect_uri: redirectUri,
    // oauthApp: false is default for GitHub Apps
  })(c, next);
});

// GitHub OAuth callback
app.get('/auth/github', async (c) => {
  const token = c.get('token');
  const user = c.get('user-github');

  if (!user) {
    return c.text('GitHub authentication failed', 400);
  }

  // Check if user is allowed
  if (!isGithubUserAllowed(user)) {
    return c.text('GitHub user not authorized', 403);
  }

  // Set session cookie
  await setSessionCookie(c, user);

  // Redirect to main app
  c.status(302);
  c.header('Location', '/');
  return c.body(null);
});

// Auth: ping (check if authenticated)
app.on(['GET', 'HEAD'], "/auth/verify-ping", async (c) => {
  const val = getCookie(c, 'sid');
  if (!val) return c.body(null, 401);
  try {
    await jwtVerify(val, SECRET);
    return c.body(null, 200);
  } catch {
    return c.body(null, 401);
  }
});

// Auth: user info (get current user data)
app.get('/auth/user', async (c) => {
  const val = getCookie(c, 'sid');
  if (!val) return c.json({ error: 'Not authenticated' }, 401);

  try {
    const { payload } = await jwtVerify(val, SECRET);
    return c.json({
      username: payload.username,
      name: payload.name,
      email: payload.email,
      avatar_url: payload.avatar_url
    });
  } catch {
    return c.json({ error: 'Invalid session' }, 401);
  }
});

// WebSocket handler - exported for testing
export const websocketHandler = (c: any) => ({
  onOpen: async (event: any, ws: any) => {
    const ok = await checkWSAuth(c);
    if (!ok) {
      ws.close();
      return;
    }
    // Initialize session tracking for this connection
    sessionIds.set(ws, "");
    ws.send(JSON.stringify({ type: "ready" }));
  },

  onMessage: async (event: any, ws: any) => {
    let data: any;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (!data?.prompt) return;

    try {
      // Validate prompt
      if (typeof data.prompt !== 'string') return;
      if (data.prompt.length > 100000) {
        ws.send(JSON.stringify({
          type: "error",
          message: 'Prompt too long. Maximum 100000 characters'
        }));
        return;
      }

      if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        ws.send(JSON.stringify({
          type: "error",
          message: "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN must be configured"
        }));
        return;
      }

      // Get the current session ID for this connection
      const currentSessionId = sessionIds.get(ws);
      let newSessionId: string | undefined;

      // Build query options
      const queryOptions: any = {
        model: 'claude-sonnet-4-5',
        cwd: "/app",
        env: process.env,
      };

      // Resume the conversation if we have a session ID from a previous response
      if (currentSessionId) {
        queryOptions.resume = currentSessionId;
      }

      // Use Claude Code SDK with session management
      const response = query({
        prompt: data.prompt,
        options: queryOptions,
      });

      for await (const message of response) {
        // Capture the new session ID from the init message
        // Each response generates a new session ID that must be used for the next query
        if (message.type === "system" && message.subtype === "init" && message.session_id) {
          newSessionId = message.session_id;
          sessionIds.set(ws, newSessionId);
        }

        // Extract text from assistant messages and stream
        if (message.type === "assistant" && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === "text") {
              // Stream character by character for CLI effect
              for (const char of block.text) {
                ws.send(JSON.stringify({ type: "text", chunk: char }));
                // Small delay for streaming effect
                await new Promise(resolve => setTimeout(resolve, 5));
              }
            }
          }
        }
      }

      ws.send(JSON.stringify({ type: "done" }));

    } catch (error: any) {
      console.error("WebSocket query error:", error.message);
      ws.send(JSON.stringify({
        type: "error",
        message: "Failed to process query"
      }));
    }
  },

  onClose: (event: any, ws: any) => {
    // Clean up session ID when connection closes
    sessionIds.delete(ws);
  }
});

// WebSocket endpoint
app.get("/ws", upgradeWebSocket(websocketHandler));

// Serve static assets (skip in test mode)
if (process.env.NODE_ENV !== 'test') {
  app.use('/assets/*', serveStatic({ root: './web/dist' }));
}

// SPA fallback - serve index.html for non-API routes
app.notFound(async (c) => {
  // For non-API routes, serve the SPA (skip in test mode)
  if (process.env.NODE_ENV !== 'test' &&
      !c.req.path.startsWith('/auth/') &&
      !c.req.path.startsWith('/ws') &&
      !c.req.path.startsWith('/query') &&
      !c.req.path.startsWith('/assets/')) {
    const staticHandler = serveStatic({
      root: './web/dist',
      path: './index.html'
    });
    try {
      const result = await staticHandler(c, async () => {});
      return result ?? c.text('Not Found', 404);
    } catch {
      return c.text('Not Found', 404);
    }
  }
  return c.text('Not Found', 404);
});

// Start server only when not in test mode
if (process.env.NODE_ENV !== 'test') {
  const server = serve({
    fetch: app.fetch,
    port: Number(PORT),
    hostname: '0.0.0.0'
  }, (info) => {
    console.log(`Server listening on ${info.address}:${info.port}`);
    console.log(`Web CLI: http://localhost:${info.port}`);
    console.log(`GitHub OAuth: http://localhost:${info.port}/auth/github`);
    console.log(`API: POST http://localhost:${info.port}/query`);
  });

  // Inject WebSocket support into the server
  injectWebSocket(server);

  // Handle graceful shutdown
  process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down gracefully");
    server.close(() => {
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    console.log("SIGINT received, shutting down gracefully");
    server.close(() => {
      process.exit(0);
    });
  });
}