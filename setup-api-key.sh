#!/bin/bash
set -e

echo "🚀 Claude Agent SDK Container - API Key Setup"
echo "=============================================="
echo ""
echo "This script will guide you through the setup process using"
echo "a standard Anthropic API key (recommended for most users)."
echo ""

# Check if running from correct directory
if [ ! -f "server.ts" ]; then
    echo "❌ Error: Please run this script from the repository root directory"
    exit 1
fi

# ============================================
# STEP 1: Get Anthropic API Key
# ============================================
echo "📋 Step 1: Anthropic API Key"
echo "-------------------------------------------"
echo ""
echo "You need an API key from Anthropic Console."
echo ""
echo "Get your API key at:"
echo "  https://console.anthropic.com/settings/keys"
echo ""
echo "Your API key should start with: sk-ant-api03-..."
echo ""
read -p "Enter your Anthropic API key: " ANTHROPIC_API_KEY

if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "❌ Error: API key is required"
    exit 1
fi

# Basic validation
if [[ ! "$ANTHROPIC_API_KEY" =~ ^sk-ant- ]]; then
    echo "⚠️  Warning: API key doesn't start with 'sk-ant-'"
    echo "   Make sure you copied it correctly from Anthropic Console"
    echo ""
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo ""
echo "✅ API key captured: ${ANTHROPIC_API_KEY:0:20}..."
echo ""

# ============================================
# STEP 2: Generate API Key for endpoint protection
# ============================================
echo "📋 Step 2: Generating API Key for endpoint protection"
echo "-------------------------------------------"
echo ""

API_KEY=$(openssl rand -hex 32 2>/dev/null || cat /dev/urandom | LC_ALL=C tr -dc 'a-zA-Z0-9' | fold -w 64 | head -n 1)

echo "✅ Generated API key: ${API_KEY:0:16}..."
echo ""

# ============================================
# STEP 3: GitHub App Setup
# ============================================
echo "📋 Step 3: GitHub App Setup"
echo "-------------------------------------------"
echo ""

# Check if GitHub credentials already exist in .env
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""

if [ -f .env ]; then
    EXISTING_CLIENT_ID=$(grep "^GITHUB_CLIENT_ID=" .env | cut -d'=' -f2 || echo "")
    EXISTING_CLIENT_SECRET=$(grep "^GITHUB_CLIENT_SECRET=" .env | cut -d'=' -f2 || echo "")

    if [ -n "$EXISTING_CLIENT_ID" ] && [ -n "$EXISTING_CLIENT_SECRET" ]; then
        echo "✅ GitHub App credentials already configured"
        echo "   Client ID: $EXISTING_CLIENT_ID"
        echo ""
        GITHUB_CLIENT_ID=$EXISTING_CLIENT_ID
        GITHUB_CLIENT_SECRET=$EXISTING_CLIENT_SECRET
    fi
fi

# Only create new GitHub App if credentials don't exist
if [ -z "$GITHUB_CLIENT_ID" ]; then
    # Generate unique app name using timestamp (max 34 chars for GitHub)
    TIMESTAMP=$(date +%Y%m%d%H%M)
    APP_NAME="claude-agent-sdk-${TIMESTAMP}"

    echo "Creating GitHub App: ${APP_NAME}"
    echo ""
    echo "Opening browser for one-click creation..."
    echo ""

# Setup server port
PORT=8765

# Kill any existing process on port
if command -v lsof &> /dev/null; then
    lsof -ti:${PORT} | xargs kill -9 2>/dev/null || true
elif command -v fuser &> /dev/null; then
    fuser -k ${PORT}/tcp 2>/dev/null || true
fi

# Create temporary server script
cat > /tmp/github-app-setup-server.js << EOF
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

const PORT = ${PORT};
const APP_NAME = "${APP_NAME}";

const manifest = {
  name: APP_NAME,
  url: "http://localhost:8080",
  redirect_url: \`http://localhost:\${PORT}/callback\`,
  callback_urls: ["http://localhost:8080/auth/github"],
  request_oauth_on_install: true,
  setup_on_update: false,
  public: false,
  default_permissions: {
    emails: "read",
    members: "read"
  },
  default_events: []
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, \`http://localhost:\${PORT}\`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(\`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>GitHub App Setup</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      max-width: 600px;
      margin: 50px auto;
      padding: 20px;
      background: #0d1117;
      color: #c9d1d9;
    }
    h1 { color: #58a6ff; }
    .button {
      background: #238636;
      color: white;
      border: none;
      padding: 12px 24px;
      font-size: 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
    }
    .button:hover { background: #2ea043; }
    .info {
      background: #161b22;
      padding: 15px;
      border-radius: 6px;
      margin: 20px 0;
      border-left: 3px solid #58a6ff;
    }
  </style>
</head>
<body>
  <h1>🚀 Create GitHub App</h1>

  <div class="info">
    <p><strong>App name:</strong> \${APP_NAME}</p>
    <p><strong>What this does:</strong></p>
    <ul>
      <li>Creates a GitHub App for OAuth authentication</li>
      <li>Requests only email and profile read permissions</li>
      <li>Automatically configures callback URLs</li>
    </ul>
  </div>

  <p>Click the button below to create the GitHub App:</p>

  <form action="https://github.com/settings/apps/new" method="post">
    <input type="hidden" name="manifest" value='\${JSON.stringify(manifest)}'>
    <button type="submit" class="button">
      Create GitHub App
    </button>
  </form>

  <p style="margin-top: 30px; color: #8b949e; font-size: 14px;">
    After clicking, GitHub will ask you to confirm the app creation.<br>
    Just click "Create GitHub App" and you'll be redirected back here automatically.
  </p>
</body>
</html>
    \`);
  } else if (url.pathname === '/callback') {
    // Handle the callback from GitHub
    const code = url.searchParams.get('code');

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Error: No code received</h1>');
      return;
    }

    try {
      // Exchange code for credentials
      const response = await fetch(\`https://api.github.com/app-manifests/\${code}/conversions\`, {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });

      if (!response.ok) {
        throw new Error(\`GitHub API error: \${response.status}\`);
      }

      credentials = await response.json();

      // Write credentials to a file that the shell script can read
      fs.writeFileSync('/tmp/github-app-credentials.json', JSON.stringify(credentials, null, 2));

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(\`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Success!</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      max-width: 600px;
      margin: 50px auto;
      padding: 20px;
      background: #0d1117;
      color: #c9d1d9;
      text-align: center;
    }
    h1 { color: #3fb950; }
    .success {
      background: #161b22;
      padding: 20px;
      border-radius: 6px;
      margin: 20px 0;
      border-left: 3px solid #3fb950;
    }
  </style>
</head>
<body>
  <h1>✅ GitHub App Created Successfully!</h1>
  <div class="success">
    <p>Your GitHub App credentials have been captured.</p>
    <p>You can close this window and return to your terminal.</p>
  </div>
</body>
</html>
      \`);

      // Shutdown server after successful callback
      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 2000);

    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(\`<h1>Error: \${error.message}</h1>\`);
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(\`Setup server running at http://localhost:\${PORT}\`);
  console.log('');
  console.log('Opening browser...');

  const open = process.platform === 'darwin' ? 'open' :
               process.platform === 'win32' ? 'start' : 'xdg-open';
  require('child_process').exec(\`\${open} http://localhost:\${PORT}\`);
});
EOF

# Start the server
node /tmp/github-app-setup-server.js &
SETUP_SERVER_PID=$!

# Wait for server to start
sleep 2

echo "⏳ Waiting for you to click 'Create GitHub App' in the browser..."
echo ""
echo "If the browser didn't open, visit: http://localhost:${PORT}"
echo ""

# Wait for credentials file to be created
while [ ! -f /tmp/github-app-credentials.json ]; do
    sleep 1
done

# Clean up server process
kill $SETUP_SERVER_PID 2>/dev/null || true

# Extract credentials
GITHUB_CLIENT_ID=$(grep -o '"client_id": *"[^"]*"' /tmp/github-app-credentials.json | cut -d'"' -f4)
GITHUB_CLIENT_SECRET=$(grep -o '"client_secret": *"[^"]*"' /tmp/github-app-credentials.json | cut -d'"' -f4)

echo ""
echo "✅ GitHub App created successfully!"
echo "   App Name: ${APP_NAME}"
echo "   Client ID: $GITHUB_CLIENT_ID"
echo ""

    # Clean up temp file
    rm -f /tmp/github-app-credentials.json
fi

# Detect GitHub username for access control (if not already detected)
if [ -z "$GH_USERNAME" ] && command -v gh &> /dev/null && gh auth status &> /dev/null; then
    GH_USERNAME=$(gh api /user --jq .login 2>/dev/null || echo "")
fi

# ============================================
# STEP 4: Configure Access Control
# ============================================
echo "📋 Step 4: Access Control Configuration"
echo "-------------------------------------------"
echo ""
echo "For security, you must configure who can access the web CLI."
echo ""

# Pre-populate with current GitHub username if available
ALLOWED_USERS=""
if [ -n "$GH_USERNAME" ]; then
    ALLOWED_USERS="$GH_USERNAME"
    echo "✅ Your GitHub username '$GH_USERNAME' has been added to the allowlist."
    echo ""
    read -p "Would you like to add additional GitHub usernames? (y/N): " -n 1 -r
    echo ""

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo ""
        read -p "Enter additional usernames (comma-separated): " ADDITIONAL_USERS
        if [ -n "$ADDITIONAL_USERS" ]; then
            ALLOWED_USERS="${ALLOWED_USERS},${ADDITIONAL_USERS}"
        fi
    fi
    echo ""
else
    # Fallback if gh CLI not available
    echo "Option 1: Allow specific GitHub usernames (comma-separated)"
    echo "Option 2: Allow all members of a GitHub organization"
    echo "Option 3: Both"
    echo ""
    read -p "Enter allowed GitHub usernames (or press ENTER to skip): " ALLOWED_USERS
fi

read -p "Enter allowed GitHub organization (or press ENTER to skip): " ALLOWED_ORG

if [ -z "$ALLOWED_USERS" ] && [ -z "$ALLOWED_ORG" ]; then
    echo ""
    echo "⚠️  Warning: You must configure at least one access control method!"
    echo ""
    read -p "Enter allowed GitHub usernames (required): " ALLOWED_USERS

    if [ -z "$ALLOWED_USERS" ]; then
        echo "❌ Error: Access control is required for security"
        exit 1
    fi
fi

# ============================================
# STEP 5: Write .env file
# ============================================
echo ""
echo "📋 Step 5: Writing .env file"
echo "-------------------------------------------"
echo ""

cat > .env << EOF
# Anthropic API Key
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY

# API Key for REST endpoint protection
CLAUDE_AGENT_SDK_CONTAINER_API_KEY=$API_KEY

# GitHub App Configuration
GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET

# GitHub Access Control
EOF

if [ -n "$ALLOWED_USERS" ]; then
    echo "ALLOWED_GITHUB_USERS=$ALLOWED_USERS" >> .env
fi

if [ -n "$ALLOWED_ORG" ]; then
    echo "ALLOWED_GITHUB_ORG=$ALLOWED_ORG" >> .env
fi

echo "✅ Created .env file with all credentials"
echo ""

# ============================================
# COMPLETE!
# ============================================
echo "🎉 Setup Complete!"
echo "================================================"
echo ""
echo "All credentials have been configured in .env"
echo ""

# Show access control summary
echo "Access Control:"
if [ -n "$ALLOWED_USERS" ]; then
    echo "  ✅ Allowed users: $ALLOWED_USERS"
fi
if [ -n "$ALLOWED_ORG" ]; then
    echo "  ✅ Allowed organization: $ALLOWED_ORG"
fi
echo ""

echo "Next steps:"
echo "  1. Build and run: ./test.sh"
echo "  2. Once running, open: http://localhost:8080"
echo ""
echo "Your API key for REST access:"
echo "  $API_KEY"
echo ""

# Clean up
rm -f /tmp/github-app-setup-server.js
rm -f /tmp/github-app-credentials.json
