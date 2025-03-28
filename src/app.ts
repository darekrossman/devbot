import dotenv from 'dotenv';
import { App, Assistant } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { GenericMessageEvent } from '@slack/web-api';

dotenv.config();

// Initialize your app with your bot token and signing secret
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Define system content for the AI Assistant
const DEFAULT_SYSTEM_CONTENT = `You are a helpful assistant that provides information about Slack.
Be friendly, concise, and helpful.`;

interface ThreadContext {
  channel?: string;
  thread_ts?: string;
}

// Define the prompt type based on Slack's requirements
interface Prompt {
  title: string;
  message: string;
  description: string;
}

// Initialize the Assistant
const assistant = new Assistant({
  threadStarted: async ({ event, say, setSuggestedPrompts, saveThreadContext }) => {
    await say('Hi, how can I help you with Slack today?');

    const prompts: [Prompt, ...Prompt[]] = [
      {
        title: 'Fun Slack fact',
        message: 'Give me a fun fact about Slack, please!',
        description: 'Learn an interesting fact about Slack',
      },
      {
        title: 'Slack tips',
        message: 'What are some useful Slack shortcuts?',
        description: 'Get helpful Slack keyboard shortcuts',
      },
      {
        title: 'About Bolt',
        message: 'Tell me about the Bolt framework',
        description: 'Learn about the Bolt framework for Slack apps',
      },
    ];

    // Provide the user up to 4 optional, preset prompts to choose from
    await setSuggestedPrompts({ prompts, title: 'Here are some suggested options:' });

    // Save thread context
    await saveThreadContext();
  },

  threadContextChanged: async ({ saveThreadContext }) => {
    await saveThreadContext();
  },

  userMessage: async ({ client, logger, message, say, setTitle, setStatus }) => {
    const msg = message as GenericMessageEvent;
    const { channel, ts, thread_ts } = msg;

    try {
      // Set the status of the Assistant to give the appearance of active processing
      await setStatus('is typing...');

      // Retrieve the Assistant thread history for context
      const thread = await (client as WebClient).conversations.replies({
        channel,
        ts: thread_ts || ts,
        oldest: thread_ts || ts,
      });

      // Process the message
      await setTitle('Slack Assistant');

      // Basic message handling logic - you can replace this with an actual LLM integration
      const userText = msg.text?.toLowerCase() || '';
      let responseText = '';

      if (userText.includes('fact')) {
        responseText =
          'Slack was originally an acronym for "Searchable Log of All Conversation and Knowledge".';
      } else if (userText.includes('shortcut')) {
        responseText =
          'Some useful Slack shortcuts include:\n• Ctrl/Cmd + K: Quick switcher\n• Ctrl/Cmd + /: View keyboard shortcuts\n• Up arrow: Edit your last message';
      } else if (userText.includes('bolt')) {
        responseText =
          "Bolt is a framework that makes it easier to build Slack apps. It handles the common patterns and allows you to focus on your app's functionality.";
      } else {
        responseText =
          "I'm your Slack assistant! You can ask me about Slack facts, shortcuts, or the Bolt framework.";
      }

      // Provide a response to the user
      await say(responseText);
    } catch (e) {
      logger.error(e);

      // Send message to advise user and clear processing status if a failure occurs
      await say('Sorry, something went wrong!');
    }
  },
});

// Register the assistant with the app
app.assistant(assistant);

(async () => {
  // Start your app
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Bolt app is running!');
})();
