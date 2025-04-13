// ============================================================================
// IMPORTS AND CONFIGURATION
// ============================================================================
import {
  App,
  Assistant,
  type BlockAction,
  type Context,
  LogLevel,
  type SayFn,
  type StaticSelectAction,
} from "@slack/bolt";
import type { ConversationsHistoryResponse, WebClient } from "@slack/web-api";
import dotenv from "dotenv";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
dotenv.config();

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================
interface SlackApiError {
  data?: {
    error?: string;
    // Add other potential properties if known
  };
  // Add other potential properties of the error object if known
}

// Type for Slack messages used in history/replies fetching and processing
// Based on common properties and potential structure from conversations.replies
interface HistoryMessage {
  type?: string;
  subtype?: string;
  ts?: string; // Optional because we might filter messages without ts
  user?: string;
  bot_id?: string;
  text?: string;
  // Add other potential properties from Slack API if needed
}

// ============================================================================
// APP INITIALIZATION
// ============================================================================
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  // logLevel: LogLevel.DEBUG,
});

// ============================================================================
// OPENAI/OPENROUTER CONFIGURATION
// ============================================================================
const openAIClient = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// ============================================================================
// CONSTANTS AND UTILITY FUNCTIONS
// ============================================================================
const DEFAULT_SYSTEM_CONTENT = `You're an AI assistant specialized in answering questions about code.
You'll analyze code-related questions and provide clear, accurate responses.
Your responses must be in Slack's markdown format.
When a prompt has Slack's special syntax like <@USER_ID> or <#CHANNEL_ID>, you must keep them as-is in your response.
You can also read and analyze any slack channel history to answer questions.`;

// List of available models (example)
const availableModels = [
  { name: "Llama 4 Maverick", id: "meta-llama/llama-4-maverick" },
  { name: "GPT-4o", id: "openai/gpt-4o" },
  { name: "GPT-4o-mini", id: "openai/gpt-4o-mini" },
  { name: "Gemini 2.5 Pro Preview", id: "google/gemini-2.5-pro-preview-03-25" },
  { name: "Quasar Alpha", id: "openrouter/quasar-alpha" },
  {
    name: "DeepSeek V3 0324",
    id: "deepseek/deepseek-chat-v3-0324",
  },
];

// User preferences storage
const DEFAULT_MODEL = "meta-llama/llama-4-maverick";
const userModelPreferences: Record<string, string> = {};

// Helper function to get a user's preferred model
function getUserModel(userId: string): string {
  return userModelPreferences[userId] || DEFAULT_MODEL;
}

// Helper function to set a user's preferred model
function setUserModel(userId: string, modelId: string): void {
  userModelPreferences[userId] = modelId;
}

// Helper function to create a Slack section block with properly formatted markdown text
function createMarkdownSectionBlock(text: string) {
  // Convert standard markdown to Slack markdown format
  let formattedText = text;

  // Convert headings (### Header) to bold text in Slack (*Header*)
  formattedText = formattedText.replace(/^###\s+(.+)$/gm, "*$1*");
  formattedText = formattedText.replace(/^##\s+(.+)$/gm, "*$1*");
  formattedText = formattedText.replace(/^#\s+(.+)$/gm, "*$1*");

  // Convert bold (**text**) to Slack bold (*text*)
  formattedText = formattedText.replace(/\*\*([^*]+)\*\*/g, "*$1*");

  // Convert bullet points to ensure proper Slack formatting
  formattedText = formattedText.replace(/^\*\s+(.+)$/gm, "• $1");
  formattedText = formattedText.replace(/^-\s+(.+)$/gm, "• $1");

  // Ensure code blocks are properly formatted
  formattedText = formattedText.replace(
    /```(\w+)?\n([\s\S]+?)\n```/gm,
    "```$1\n$2\n```",
  );

  // Convert inline code
  formattedText = formattedText.replace(/`([^`]+)`/g, "`$1`");

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: formattedText,
    },
  };
}

// ============================================================================
// REUSABLE MESSAGE PROCESSING LOGIC
// ============================================================================

async function processThreadedMessage(
  channel: string,
  thread_ts: string, // The TS of the thread (must exist)
  userMessageText: string,
  client: WebClient, // Use specific type
  say: SayFn, // Use specific type
  context: Context, // Use specific type
  userId: string, // Add userId parameter
) {
  try {
    console.log(
      `Processing message in thread ${thread_ts}: "${userMessageText}"`,
    );

    // 1. Fetch Thread History
    const thread = await client.conversations.replies({
      channel,
      ts: thread_ts,
      oldest: thread_ts,
      limit: 50, // Consider adding a limit for very long threads
    });

    // Filter out the triggering message itself if needed (e.g., for app_mention)
    // In a generic message handler, the latest message IS the one we process
    const threadHistory: ChatCompletionMessageParam[] =
      thread.messages
        ?.filter(
          (m): m is HistoryMessage =>
            !!m.text && (!!m.bot_id || !!m.user) && !!m.ts,
        ) // Type guard and filter needed props
        // Exclude the *very last* message which is the current user message being processed (its text is in userMessageText)
        ?.filter((_, index, arr) => index < arr.length - 1)
        ?.map(
          (m): ChatCompletionMessageParam => ({
            // Map to the OpenAI format
            role: m.bot_id ? ("assistant" as const) : ("user" as const),
            content: m.text || "", // We already filtered for text, but satisfy TS
          }),
        ) || [];

    // 2. Prepare messages for the LLM
    const userMessage = { role: "user" as const, content: userMessageText };
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      ...threadHistory, // Add filtered thread history
      userMessage, // Add the current user message
    ].filter((m): m is ChatCompletionMessageParam => !!m.content); // Ensure no empty content

    // 3. Call OpenAI API with user's preferred model
    const modelResponse = await openAIClient.chat.completions.create({
      model: getUserModel(userId),
      messages: messages,
      max_tokens: 2000,
    });

    const responseText =
      modelResponse.choices[0].message.content ||
      "Sorry, I couldn't generate a response.";

    // 4. Respond in the thread using a Markdown block
    await say({
      text: responseText, // Fallback text for notifications
      blocks: [createMarkdownSectionBlock(responseText)],
      thread_ts: thread_ts,
    });
  } catch (error) {
    console.error(`Error processing message in thread ${thread_ts}:`, error);
    try {
      await say({
        text: "I'm sorry, I encountered an error processing this message. Please try again.",
        blocks: [
          createMarkdownSectionBlock(
            "I'm sorry, I encountered an error processing this message. Please try again.",
          ),
        ],
        thread_ts: thread_ts,
      });
    } catch (sayError) {
      console.error(
        `Failed to send error message in thread ${thread_ts}:`,
        sayError,
      );
    }
  }
}

// ============================================================================
// ASSISTANT CONFIGURATION
// ============================================================================
const assistant = new Assistant({
  threadStarted: async ({
    event,
    say,
    setSuggestedPrompts,
    saveThreadContext,
  }) => {
    const { context } = event.assistant_thread;

    try {
      await say(
        "Hi! I'm your coding assistant. Ask me any questions about code!",
      );

      await saveThreadContext();

      const prompts = [
        {
          title: "Code Example",
          message:
            "Show me an example of implementing a binary search tree in JavaScript.",
        },
        {
          title: "Code Review",
          message:
            "What are best practices for writing clean, maintainable code?",
        },
        {
          title: "Debug Help",
          message: "How do I debug memory leaks in Node.js applications?",
        },
      ] as [
        { title: string; message: string },
        ...{ title: string; message: string }[],
      ];

      if (context.channel_id) {
        prompts.push({
          title: "Summarize channel",
          message: "Assistant, please summarize the activity in this channel!",
        });
      }

      await setSuggestedPrompts({
        prompts,
        title: "Here are some questions you can ask:",
      });
    } catch (error) {
      console.error("Error in threadStarted:", error);
    }
  },

  userMessage: async ({
    message,
    client,
    say,
    setTitle,
    setStatus,
    getThreadContext,
    logger,
  }) => {
    // Assert message type to include expected properties for this context
    const assertedMessage = message as {
      channel: string;
      thread_ts: string;
      text?: string;
      user?: string;
    };
    const { channel, thread_ts, user } = assertedMessage;
    const messageText = assertedMessage.text || "";

    try {
      await setTitle(messageText);
      await setStatus("is thinking...");

      if (
        messageText ===
        "Assistant, please summarize the activity in this channel!"
      ) {
        const threadContext = await getThreadContext();
        let channelHistory: ConversationsHistoryResponse = {
          ok: false,
          messages: [],
        };
        const channelId = threadContext.channel_id || channel;

        try {
          channelHistory = await client.conversations.history({
            channel: channelId,
            limit: 50,
          });
        } catch (e) {
          // If the Assistant is not in the channel it's being asked about,
          // have it join the channel and then retry the API call
          if (
            e &&
            typeof e === "object" &&
            "data" in e &&
            (e as SlackApiError).data?.error === "not_in_channel"
          ) {
            await client.conversations.join({
              channel: channelId,
            });
            channelHistory = await client.conversations.history({
              channel: channelId,
              limit: 50,
            });
          } else {
            logger.error(e);
          }
        }
        // Prepare and tag the prompt and messages for LLM processing
        let llmPrompt = `Generate a brief summary of the following messages from Slack channel <#${channelId}:`;

        for (const m of channelHistory?.messages?.reverse() || []) {
          if (m.user) llmPrompt += `\n<@${m.user}> says: ${m.text}`;
        }

        const messages: ChatCompletionMessageParam[] = [
          { role: "system", content: DEFAULT_SYSTEM_CONTENT },
          { role: "user", content: llmPrompt },
        ];

        // Send channel history and prepared request to LLM
        const llmResponse = await openAIClient.chat.completions.create({
          model: getUserModel(user || ""),
          n: 1,
          messages,
        });

        // Provide a response to the user
        await say({
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: llmResponse.choices[0].message.content || "",
              },
            },
          ],
        });

        return;
      }

      // Retrieve the Assistant thread history for context of question being asked
      const thread = await client.conversations.replies({
        channel,
        ts: thread_ts,
        oldest: thread_ts,
      });

      // Prepare and tag each message for LLM processing
      const userMessage = { role: "user" as const, content: messageText };

      const threadHistory: ChatCompletionMessageParam[] =
        thread.messages
          ?.filter((m) => m.text && (m.bot_id || m.user))
          ?.map((m) => {
            const role = m.bot_id ? ("assistant" as const) : ("user" as const);
            // Return type should be compatible with ChatCompletionMessageParam elements
            return { role, content: m.text || "" };
          }) || [];

      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: DEFAULT_SYSTEM_CONTENT },
        ...threadHistory,
        userMessage,
      ].filter((m): m is ChatCompletionMessageParam => !!m.content); // Keep type guard

      // Use OpenAI client for chat completion via OpenRouter
      const modelResponse = await openAIClient.chat.completions.create({
        model: getUserModel(user || ""),
        messages: messages,
        max_tokens: 2000,
      });

      await setStatus("is typing...");
      await say({
        blocks: [
          createMarkdownSectionBlock(
            modelResponse.choices[0].message.content || "",
          ),
        ],
      });
    } catch (error) {
      console.error("Error in userMessage:", error);
      await say({
        text: "I'm sorry, I ran into an error processing your request. Please try again.",
        blocks: [
          createMarkdownSectionBlock(
            "I'm sorry, I ran into an error processing your request. Please try again.",
          ),
        ],
      });
    }
  },

  threadContextChanged: async ({ logger, saveThreadContext }) => {
    // const { channel_id, thread_ts, context: assistantContext } = event.assistant_thread;
    try {
      await saveThreadContext();
    } catch (e) {
      logger.error(e);
    }
  },
});

// Register the assistant with the app
app.assistant(assistant);

// ============================================================================
// CUSTOM FUNCTION HANDLERS
// ============================================================================
app.function(
  "code_assist",
  async ({ client, inputs, complete, fail, body }) => {
    console.log("codeassist!");
    try {
      const { channel_id, message_id, user_id } = inputs as {
        channel_id: string;
        message_id: string;
        user_id: string;
      };

      const ackMessage = await client.chat.postMessage({
        channel: channel_id,
        text: "You have summoned Codar, stand by...",
        blocks: [
          createMarkdownSectionBlock("You have summoned Codar, stand by..."),
        ],
      });

      let messages: ChatCompletionMessageParam[] | undefined;

      try {
        const result = await client.conversations.history({
          channel: channel_id,
          oldest: message_id,
          limit: 1,
          inclusive: true,
        });

        messages = [
          { role: "system", content: DEFAULT_SYSTEM_CONTENT },
          { role: "user", content: result.messages?.[0]?.text || "" },
        ];
      } catch (e: unknown) {
        // If the Assistant is not in the channel it's being asked about,
        // have it join the channel and then retry the API call
        // Use the interface for type checking
        let isNotInChannelError = false;
        if (
          typeof e === "object" &&
          e !== null &&
          "data" in e &&
          typeof (e as SlackApiError).data === "object" &&
          (e as SlackApiError).data !== null &&
          "error" in ((e as SlackApiError).data || {}) && // Check error exists on data
          (e as SlackApiError).data?.error === "not_in_channel"
        ) {
          isNotInChannelError = true;
        }

        if (isNotInChannelError) {
          await client.conversations.join({ channel: channel_id });
          const result = await client.conversations.history({
            channel: channel_id,
            oldest: message_id,
            limit: 1,
            inclusive: true,
          });

          messages = [
            { role: "system", content: DEFAULT_SYSTEM_CONTENT },
            { role: "user", content: result.messages?.[0]?.text || "" },
          ];
        } else {
          console.error(e);
        }
      }

      // Ensure messages is defined before proceeding
      if (!messages) {
        fail({ error: "Failed to retrieve message history." });
        return;
      }

      // Use OpenAI client for chat completion via OpenRouter
      const modelResponse = await openAIClient.chat.completions.create({
        model: getUserModel(user_id),
        messages: messages,
        max_tokens: 2000,
      });

      const responseText = modelResponse.choices[0].message.content || "";

      await complete({
        outputs: {
          message: user_id,
        },
      });

      await client.chat.update({
        channel: channel_id,
        ts: ackMessage.ts || "",
        text: "",
        blocks: [
          createMarkdownSectionBlock(`<@${user_id}>,\n\n${responseText}`),
        ],
      });
    } catch (error) {
      console.error(error);
      fail({ error: `Failed to complete the step: ${error}` });
    }
  },
);

// ============================================================================
// EVENT HANDLERS
// ============================================================================

// Handles direct mentions (@BotName)
app.event("app_mention", async ({ event, context, client, say }) => {
  const disabled = true;
  if (disabled) {
    await say({
      text: "Im not talking direct mentions at the moment. Start a new thread with me instead.",
      blocks: [
        createMarkdownSectionBlock(
          "I'm not talking direct mentions at the moment. Start a new thread with me instead.",
        ),
      ],
    });
    return;
  }

  try {
    const botUserId = context.botUserId; // Get the bot's user ID

    // Remove the mention from the text, ensuring it's not null/undefined
    const messageText = (event.text || "")
      .replace(`<@${botUserId}>`, "")
      .trim();
    const channel = event.channel;
    // Use event.ts as the thread_ts if the mention is not already in a thread
    const thread_ts = event.thread_ts || event.ts;
    const user = event.user; // User who mentioned the bot

    // Ensure we have a valid user ID before proceeding
    if (!user) {
      console.log("App mention received without a valid user ID, ignoring.");
      return;
    }

    // Check if message text is empty after removing mention
    if (!messageText) {
      console.log(`Ignoring empty mention from ${user} in channel ${channel}`);
      // Optionally send a help message or do nothing
      await say({
        text: "How can I help you?",
        blocks: [createMarkdownSectionBlock("How can I help you?")],
        thread_ts: thread_ts || event.ts,
      });
      return;
    }

    console.log(
      `Processing mention from ${user} in channel ${channel} (thread: ${thread_ts}): "${messageText}"`,
    );

    // Call the reusable processing function
    await processThreadedMessage(
      channel,
      thread_ts,
      messageText,
      client,
      say,
      context,
      user,
    );
  } catch (error) {
    console.error("Error in app_mention:", error);
    // Attempt to notify the user in the channel/thread about the error
    try {
      const replyThreadTs = event.thread_ts || event.ts;
      await say({
        text: "I'm sorry, I ran into an error processing your mention. Please try again.",
        blocks: [
          createMarkdownSectionBlock(
            "I'm sorry, I ran into an error processing your mention. Please try again.",
          ),
        ],
        thread_ts: replyThreadTs,
      });
    } catch (sayError) {
      console.error("Failed to send error message via say:", sayError);
    }
  }
});

// Handles subsequent messages in a thread where the bot was mentioned or has replied
app.event("message", async ({ event, context, client, say, message }) => {
  const botUserId = context.botUserId;

  // Use `in` operator for safe property checking against the potentially broad `message` type

  // 0. Ignore messages that are direct mentions (handled by app_mention)
  // Check for text property first, then check content
  if ("text" in message && message.text?.includes(`<@${botUserId}>`)) {
    return;
  }

  // 1. Ignore messages from bots (including self)
  if ("bot_id" in message && message.bot_id) {
    return;
  }

  // 2. Ignore messages with subtypes we don't want to process (e.g., channel joins, message edits)
  // Allow undefined subtype (standard user message) or 'thread_broadcast'
  if (
    "subtype" in message &&
    message.subtype &&
    message.subtype !== "thread_broadcast"
  ) {
    return;
  }

  // 3. Ensure the message is in a thread AND has text content.
  if (
    !("thread_ts" in message && message.thread_ts) ||
    !(
      "text" in message &&
      typeof message.text === "string" &&
      message.text.trim() !== ""
    )
  ) {
    return;
  }

  // 4. Now we know it's a user text message in a thread with the necessary properties.
  // TypeScript should now allow accessing these properties safely.
  const channel = message.channel; // Standard property, usually safe
  const thread_ts = message.thread_ts; // Checked above
  const userMessageText = message.text; // Checked above
  const user = message.user; // Get the user ID

  // Ensure we have a valid user ID before proceeding
  if (!user) {
    console.log("Message received without a valid user ID, ignoring.");
    return;
  }

  try {
    // 5. Check if the bot is considered "involved" in this thread.
    // Fetch the *full* thread history to make a reliable decision.
    const history = await client.conversations.replies({
      channel: channel,
      ts: thread_ts,
      limit: 5,
    });

    // Check if any message mentions the bot OR is from the bot
    const botIsMentioned = history.messages?.some(
      (m) => "text" in m && m.text?.includes(`<@${botUserId}>`),
    );
    const botHasReplied = history.messages?.some(
      (m) => "bot_id" in m && m.bot_id === botUserId,
    );

    const botIsInvolved = botIsMentioned || botHasReplied;

    if (botIsInvolved) {
      console.log(
        `Bot is involved in thread ${thread_ts}, processing user message...`,
      );
      // Call the reusable processing function
      await processThreadedMessage(
        channel,
        thread_ts,
        userMessageText,
        client,
        say,
        context,
        user,
      );
    } else {
      // Bot is not involved in the thread (no mention found, bot hasn't replied). Ignore.
      console.log(
        `Bot is not involved in thread ${thread_ts}. Ignoring message.`,
      );
    }
  } catch (error) {
    console.error(`Error in message handler for thread ${thread_ts}:`, error);
    // Avoid replying with an error message here to prevent potential loops if the error persists
  }
});

// Listen for users opening your App Home
app.event("app_home_opened", async ({ event, client, logger }) => {
  try {
    const userId = event.user;
    const userModel = getUserModel(userId);

    // Call views.publish with the built-in client
    await client.views.publish({
      // Use the user ID associated with the event
      user_id: userId,
      view: {
        // Home tabs must be enabled in your app configuration page under "App Home"
        type: "home",
        blocks: [
          createMarkdownSectionBlock(
            `*Welcome home, <@${userId}> :house:*\n\nI'm Codar, your AI coding assistant! I can help you with code questions, debugging, best practices, and more. You can mention me in any channel (\`@Codar\`) or start a thread with me directly.`,
          ),
          { type: "divider" },
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "text",
                    text: "Select an AI model",
                    style: { bold: true },
                  },
                ],
              },
            ],
          },
          {
            type: "actions",
            block_id: "model_select_input_block",
            elements: [
              {
                type: "static_select",
                placeholder: {
                  type: "plain_text",
                  text: "Select a model",
                  emoji: true,
                },
                options: availableModels.map((model) => ({
                  text: {
                    type: "plain_text",
                    text: model.name,
                    emoji: true,
                  },
                  value: model.id,
                })),
                action_id: "model_select_action",
                initial_option: availableModels.find((m) => m.id === userModel)
                  ? {
                      text: {
                        type: "plain_text",
                        text:
                          availableModels.find((m) => m.id === userModel)
                            ?.name || "",
                        emoji: true,
                      },
                      value: userModel,
                    }
                  : undefined,
              },
            ],
          },
          { type: "divider" },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "Need help? Check out the <https://docs.slack.dev/block-kit/|Block Kit documentation> or ask me a question!",
              },
            ],
          },
        ],
      },
    });
  } catch (error) {
    logger.error(error);
  }
});

// TEMPORARY DEBUGGING: Catch all actions
app.action({}, async ({ ack, body, logger }) => {
  logger.info("--- GENERIC ACTION CAUGHT ---");
  logger.info(JSON.stringify(body, null, 2)); // Log the entire body structure
  await ack();
});

// Handle the model selection action
app.action("model_select_action", async ({ ack, body, client, logger }) => {
  await ack(); // Acknowledge the action

  // Type assertion for safety, using the specific Bolt types
  const actionBody = body as BlockAction<StaticSelectAction>; // Correct type
  const selectedOption = actionBody.actions?.[0]?.selected_option;

  if (selectedOption?.value) {
    const newModelId = selectedOption.value;
    const userId = actionBody.user.id;
    setUserModel(userId, newModelId); // Update the user's preference
    logger.info(`User ${userId} selected model: ${newModelId}`);

    // Send confirmation message
    try {
      await client.chat.postEphemeral({
        channel: userId, // Send to the user directly in Slackbot chat
        user: userId,
        text: `Model updated to: ${selectedOption.text.text}`,
      });
    } catch (error) {
      logger.error("Failed to send ephemeral confirmation message:", error);
    }
  } else {
    logger.warn(
      "Model selection action received without a valid selected option.",
    );
  }
});

// ============================================================================
// APP STARTUP
// ============================================================================
(async () => {
  try {
    await app.start();
    console.log("⚡️ Code Assistant app is running!");
  } catch (error) {
    console.error("Failed to start app:", error);
  }
})();
