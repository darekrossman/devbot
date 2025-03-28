# Slack Bolt App

A TypeScript-based Slack app using Bolt framework with AI Assistant functionality.

## Setup

1. Create a `.env` file with the following variables:
```
SLACK_SIGNING_SECRET=your_signing_secret
SLACK_BOT_TOKEN=your_bot_token
SLACK_APP_TOKEN=your_app_token
```

2. Install dependencies:
```
pnpm install
```

3. Start the app in development mode (with auto-reload):
```
pnpm dev
```

Or build and start in production mode:
```
pnpm build
pnpm start
```

## Features

- Responds to the message "hello" with a greeting
- AI Assistant that:
  - Starts threads with a welcome message and suggested prompts
  - Responds to user messages with information about Slack
  - Maintains thread context as users navigate through Slack

## App Configuration

To enable AI assistant functionality in your Slack App settings:

1. Enable the **Agents & AI Apps** feature in App Settings
2. Add the following scopes in the **OAuth & Permissions** page:
   - `assistant:write`
   - `chat:write`
   - `im:history`
3. Subscribe to the following events in the **Event Subscriptions** page:
   - `assistant_thread_started`
   - `assistant_thread_context_changed`
   - `message.im`

## Development

The app is written in TypeScript and uses the following tools:
- `typescript` for type safety
- `nodemon` for auto-reloading during development
- `ts-node` for running TypeScript files directly
- `prettier` for code formatting

### Code Formatting

The project uses Prettier for consistent code formatting. You can format your code with:

```
pnpm format
```

To check if your code is properly formatted without making changes:

```
pnpm format:check
``` 