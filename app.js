// Forteil Hackathon Bot - Production Ready Version (Working)
const { App } = require('@slack/bolt');
const { Pool } = require('pg');
const cron = require('node-cron');
require('dotenv').config();

// Configuration - alle settings samlet
const CONFIG = {
  dadJokeChance: parseFloat(process.env.DAD_JOKE_CHANCE) || 0.25,
  adminUserId: process.env.ADMIN_USER_ID || 'U07M4BA86LF',
  maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
  dbTimeout: parseInt(process.env.DB_TIMEOUT) || 10000,
  rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000, // 1 min
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX) || 10
};

// Request tracking for debugging
let requestCounter = 0;
const generateRequestId = () => `req_${Date.now()}_${++requestCounter}`;

// Rate limiting storage
const rateLimitStore = new Map();

// Database connection with optimized settings
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10, // maximum number of clients in pool
  idleTimeoutMillis: 30000, // close idle clients after 30 seconds
  connectionTimeoutMillis: CONFIG.dbTimeout,
});

// Graceful pool shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  port: process.env.PORT || 3000
});

// Shared constants - no duplication
const MOTIVATIONAL_MESSAGES = [
  (total) => `🌅 God morgen, idé-maskiner, alle jer vidunderlige Forteilees! Vi har ${total} fantastiske idéer indtil nu!`,
  (total) => `☕ Kaffe-tid! Vores idé-tæller står på ${total} - skal vi runde op, kære Forteilees?`,
  (total) => `🧠 Dagens brainstorm-update: ${total} idéer og counting, fantastiske Forteilees!`,
  (total) => `⚡ Lightning round! Vi har ${total} idéer - hvad kommer der næst, dygtige Forteilees?`,
  (total) => `🎯 Målrettet opdatering: ${total} idéer på tavlen, vidunderlige Forteilees!`
];

const FUNNY_RESPONSES = [
  "🚀 Den idé fik lige min indre nørd til at juble!",
  "💡 *Chef's kiss* - det er simpelt og smart!",
  "🤖 Beep boop! Min algoritme siger: GENIAL!",
  "⚡ Den idé sparkler som fresh commits på fredag eftermiddag!",
  "🎯 Bulls-eye! Det rammer lige i Forteil-filosofien!",
  "🔥 Hot take alert! Den her idé er 🔥🔥🔥",
  "🎪 *Standing ovation fra alle mine virtuelle personligheder*",
  "💎 Rare gem spotted! Den her går direkte til favorit-listen!",
  "🎨 Kreativitet level: Over 9000!",
  "🍕 Den idé fortjener pizza som belønning!"
];

const DAD_JOKES = [
  "Hvorfor elsker programmører mørke? Fordi lys tiltrækker bugs! 🐛",
  "Hvad siger en AI når den er træt? 'Jeg trænger til at reboote!' 💤",
  "Hvorfor gik API'et til tandlægen? Det havde dårlige endpoints! 🦷",
  "Hvad kalder man en hacker der laver kaffe? En Java developer! ☕",
  "Hvorfor blev robotten fyret? Den havde for mange glitches i sin performance review! 🤖",
  "Hvad er forskellen på en programmør og en almindelig person? Programmøren tænker der er 10 typer mennesker i verden!",
  "Hvorfor gik udvikler til psykologen? Hun havde for mange issues!",
  "Hvad siger en database til en anden? Skal vi JOIN sammen?"
];

const REACTIONS = ['rocket', 'bulb', 'zap', 'dart', 'fire', 'gem', 'star', 'clap', 'tada', 'muscle'];

// Utility functions
const logWithContext = (level, message, context = {}) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...context
  };
  console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`, context);
  return logEntry;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Rate limiting
const isRateLimited = (userId) => {
  const now = Date.now();
  const userHistory = rateLimitStore.get(userId) || [];
  
  // Remove old entries
  const validEntries = userHistory.filter(time => now - time < CONFIG.rateLimitWindow);
  
  if (validEntries.length >= CONFIG.rateLimitMax) {
    return true;
  }
  
  validEntries.push(now);
  rateLimitStore.set(userId, validEntries);
  return false;
};

// Database functions with error handling and optimization
const executeWithRetry = async (operation, maxRetries = CONFIG.maxRetries) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      logWithContext('error', `Database operation failed (attempt ${attempt}/${maxRetries})`, {
        error: error.message,
        stack: error.stack
      });
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      await sleep(1000 * attempt); // Exponential backoff
    }
  }
};

// Optimized single-query stats function
const getIdeaStats = async (requestId) => {
  return executeWithRetry(async () => {
    logWithContext('info', 'Fetching idea statistics', { requestId });
    
    const query = `
      WITH category_stats AS (
        SELECT category, COUNT(*) as count
        FROM ideas 
        GROUP BY category 
        ORDER BY count DESC
      ),
      user_stats AS (
        SELECT username, COUNT(*) as idea_count
        FROM ideas 
        GROUP BY username 
        ORDER BY idea_count DESC
        LIMIT 5
      ),
      total_stats AS (
        SELECT COUNT(*) as total FROM ideas
      )
      SELECT 
        (SELECT total FROM total_stats) as total,
        (SELECT json_agg(json_build_object('category', category, 'count', count)) FROM category_stats) as categories,
        (SELECT json_agg(json_build_object('username', username, 'idea_count', idea_count)) FROM user_stats) as top_users
    `;
    
    const result = await pool.query(query);
    const stats = result.rows[0];
    
    // Format results
    return {
      total: parseInt(stats.total) || 0,
      categories: stats.categories || [],
      topUsers: stats.top_users || []
    };
  });
};

const saveIdea = async (userId, username, text, category, messageTs, channelId, requestId) => {
  return executeWithRetry(async () => {
    logWithContext('info', 'Saving new idea', { 
      requestId, 
      userId, 
      username, 
      category,
      textLength: text.length 
    });
    
    const query = `
      INSERT INTO ideas (user_id, username, idea_text, category, message_ts, channel_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING id
    `;
    const result = await pool.query(query, [userId, username, text, category, messageTs, channelId]);
    return result.rows[0].id;
  });
};

const saveReaction = async (ideaId, reactionType, responseText, requestId) => {
  return executeWithRetry(async () => {
    const query = `
      INSERT INTO reactions (idea_id, reaction_type, response_text, created_at)
      VALUES ($1, $2, $3, NOW())
    `;
    await pool.query(query, [ideaId, reactionType, responseText]);
    logWithContext('info', 'Reaction saved', { requestId, ideaId, reactionType });
  });
};

// Enhanced categorization
const categorizeIdea = (text) => {
  const lowerText = text.toLowerCase();
  
  const categories = [
    {
      name: '🤖 AI & Automatisering',
      emoji: 'robot_face',
      keywords: ['ai', 'chatbot', 'automatiser', 'machine learning', 'intelligent', 'smart']
    },
    {
      name: '🔗 Integrationer',
      emoji: 'link',
      keywords: ['slack', 'integration', 'api', 'connect', 'sync', 'webhook']
    },
    {
      name: '⚙️ Procesoptimering',
      emoji: 'gear',
      keywords: ['process', 'workflow', 'effektiv', 'optimering', 'automation', 'streamline']
    },
    {
      name: '📊 Data & Visualisering',
      emoji: 'bar_chart',
      keywords: ['dashboard', 'rapporter', 'data', 'analytics', 'metrics', 'visualization']
    },
    {
      name: '🎨 UI/UX Forbedringer',
      emoji: 'art',
      keywords: ['interface', 'design', 'bruger', 'frontend', 'ui', 'ux', 'mobile']
    }
  ];
  
  for (const category of categories) {
    if (category.keywords.some(keyword => lowerText.includes(keyword))) {
      return category;
    }
  }
  
  return { name: '💡 Kreative Løsninger', emoji: 'bulb' };
};

// Generate motivational message
const generateMotivationalMessage = (stats) => {
  const messageGenerator = MOTIVATIONAL_MESSAGES[Math.floor(Math.random() * MOTIVATIONAL_MESSAGES.length)];
  const randomMessage = messageGenerator(stats.total);
  
  const topCategory = stats.categories.length > 0 ? stats.categories[0] : null;
  const categoryText = topCategory ? 
    `\n🏆 Mest populære kategori: ${topCategory.category} (${topCategory.count} idéer)` : '';
  
  return `${randomMessage}${categoryText}\n\n💡 Brug /hackathon-stats for fuld oversigt!\n\n<!channel> Få delt flere idéer! 🚀`;
};

// Main message handler with comprehensive error handling
app.message(async ({ message, client }) => {
  const requestId = generateRequestId();
  
  try {
    // Basic validation
    if (message.bot_id) return;
    
    if (process.env.HACKATHON_CHANNEL_ID && message.channel !== process.env.HACKATHON_CHANNEL_ID) {
      return;
    }
    
    if (!message.text || !message.text.toLowerCase().startsWith('ide')) {
      return;
    }
    
    // Rate limiting
    if (isRateLimited(message.user)) {
      logWithContext('warn', 'User rate limited', { requestId, userId: message.user });
      return;
    }
    
    logWithContext('info', 'Processing idea message', { 
      requestId, 
      userId: message.user, 
      messageLength: message.text.length 
    });
    
    // Get username with fallback
    let username = 'Anonymous';
    try {
      const userInfo = await client.users.info({ user: message.user });
      username = userInfo.user.display_name || userInfo.user.real_name || userInfo.user.name || 'Anonymous';
    } catch (error) {
      logWithContext('warn', 'Could not fetch user info, using fallback', { requestId, error: error.message });
    }
    
    // Categorize and save
    const category = categorizeIdea(message.text);
    
    const ideaId = await saveIdea(
      message.user,
      username,
      message.text,
      category.name,
      message.ts,
      message.channel,
      requestId
    );
    
    if (!ideaId) {
      throw new Error('Failed to save idea to database');
    }
    
    // Add reactions
    const randomReaction = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
    
    await Promise.all([
      client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: randomReaction
      }),
      client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: category.emoji
      })
    ]);
    
    logWithContext('info', 'Reactions added successfully', { requestId, ideaId });
    
    // Send response with delay for dramatic effect
    setTimeout(async () => {
      try {
        const randomResponse = FUNNY_RESPONSES[Math.floor(Math.random() * FUNNY_RESPONSES.length)];
        
        await client.chat.postMessage({
          channel: message.channel,
          text: randomResponse,
          thread_ts: message.ts
        });
        
        await saveReaction(ideaId, 'response', randomResponse, requestId);
        
        // Dad joke chance
        if (Math.random() < CONFIG.dadJokeChance) {
          setTimeout(async () => {
            try {
              const randomJoke = DAD_JOKES[Math.floor(Math.random() * DAD_JOKES.length)];
              await client.chat.postMessage({
                channel: message.channel,
                text: `Bonus dad joke: ${randomJoke}`,
                thread_ts: message.ts
              });
              
              await saveReaction(ideaId, 'dad_joke', randomJoke, requestId);
              logWithContext('info', 'Dad joke sent', { requestId, ideaId });
            } catch (error) {
              logWithContext('error', 'Dad joke failed', { requestId, error: error.message });
            }
          }, 2000);
        }
        
        logWithContext('info', 'Message processing completed successfully', { requestId, ideaId });
        
      } catch (error) {
        logWithContext('error', 'Response sending failed', { requestId, error: error.message });
      }
    }, Math.random() * 3000 + 1000);
    
  } catch (error) {
    logWithContext('error', 'Message processing failed', { 
      requestId, 
      userId: message.user,
      error: error.message,
      stack: error.stack
    });
  }
});

// Enhanced stats command with loading state
app.command('/hackathon-stats', async ({ command, ack, respond }) => {
  const requestId = generateRequestId();
  await ack();
  
  try {
    // Rate limiting
    if (isRateLimited(command.user_id)) {
      await respond({
        text: '⏳ Hold lige! Du spørger lidt for hurtigt. Prøv igen om lidt.',
        response_type: 'ephemeral'
      });
      return;
    }
    
    logWithContext('info', 'Stats command requested', { requestId, userId: command.user_id });
    
    const stats = await getIdeaStats(requestId);
    
    if (!stats) {
      await respond({
        text: '❌ Kunne ikke hente statistikker. Database fejl - kontakt admin.',
        response_type: 'ephemeral'
      });
      return;
    }
    
    const categoryText = stats.categories.length > 0 ? 
      stats.categories.map(cat => `${cat.category}: ${cat.count}`).join('\n') : 
      'Ingen kategorier endnu';
    
    const topUsersText = stats.topUsers.length > 0 ? 
      stats.topUsers.map((user, index) => `${index + 1}. ${user.username}: ${user.idea_count} idéer`).join('\n') :
      'Ingen brugere endnu';
    
    const statsMessage = `
🎯 *Hackathon Idé-Status*

📈 *Total idéer:* ${stats.total}

📊 *Kategorier:*
${categoryText}

🏆 *Top Idé-Generatorer:*
${topUsersText}

💪 *Status:* ${stats.total > 10 ? 'Vi er klar til at rocke hackathon! 🚀' : 'Vi har brug for flere idéer! Kom nu, folk! <!channel>'}

_Fortsæt med at dele idéer i #hackathon-ideas!_
    `;
    
    await respond({
      text: statsMessage,
      response_type: 'in_channel'
    });
    
    logWithContext('info', 'Stats command completed', { requestId, totalIdeas: stats.total });
    
  } catch (error) {
    logWithContext('error', 'Stats command failed', { requestId, error: error.message });
    await respond({
      text: '❌ Ups! Noget gik galt ved hentning af statistikker. Prøv igen om lidt! 🤖',
      response_type: 'ephemeral'
    });
  }
});

// Enhanced manual motivation trigger
app.command('/motivate-now', async ({ command, ack, respond }) => {
  const requestId = generateRequestId();
  await ack();
  
  try {
    if (command.user_id !== CONFIG.adminUserId) {
      await respond({
        text: '❌ Kun admin kan sende manuel motivationsbesked!',
        response_type: 'ephemeral'
      });
      return;
    }
    
    // Rate limiting even for admin
    if (isRateLimited(`admin_${command.user_id}`)) {
      await respond({
        text: '⏳ Vent lidt med at sende flere motivationsbeskeder.',
        response_type: 'ephemeral'
      });
      return;
    }
    
    logWithContext('info', 'Manual motivation triggered', { requestId, adminId: command.user_id });
    
    if (!process.env.HACKATHON_CHANNEL_ID) {
      await respond({
        text: '❌ HACKATHON_CHANNEL_ID ikke konfigureret!',
        response_type: 'ephemeral'
      });
      return;
    }
    
    const stats = await getIdeaStats(requestId);
    
    if (!stats || stats.total === 0) {
      await respond({
        text: '⚠️ Ingen idéer i database endnu - post nogle "Ide:" beskeder først!',
        response_type: 'ephemeral'
      });
      return;
    }
    
    const motivationMessage = generateMotivationalMessage(stats);
    
    await app.client.chat.postMessage({
      channel: process.env.HACKATHON_CHANNEL_ID,
      text: motivationMessage
    });
    
    await respond({
      text: `✅ **Manuel motivationsbesked sendt!**\n\n📊 Stats: ${stats.total} idéer\n🕐 Tid: ${new Date().toLocaleTimeString('da-DK', {timeZone: 'Europe/Copenhagen'})}\n🎯 Besked sendt til #hackathon-ideas`,
      response_type: 'ephemeral'
    });
    
    logWithContext('info', 'Manual motivation sent successfully', { requestId, totalIdeas: stats.total });
    
  } catch (error) {
    logWithContext('error', 'Manual motivation failed', { requestId, error: error.message });
    await respond({
      text: `❌ **Fejl ved afsendelse:**\n\n\`\`\`${error.message}\`\`\``,
      response_type: 'ephemeral'
    });
  }
});

// Help command for user guidance
app.command('/hackathon-help', async ({ command, ack, respond }) => {
  await ack();
  
  const helpMessage = `
🤖 **Forteil Hackathon Bot - Hjælp**

**📝 Sådan Poster Du en Idé:**
Start din besked med "Ide:" efterfulgt af din idé:
\`Ide: AI chatbot til HR-spørgsmål\`

**🎯 Bot Reaktioner:**
• 2 emoji reactions (random + kategori)
• Vittigt svar i thread
• 25% chance for bonus dad joke
• Automatisk kategorisering og database lagring

**📊 Available Commands:**
• \`/hackathon-stats\` - Se alle statistikker
• \`/hackathon-help\` - Denne hjælp besked
• \`/leaderboard\` - Live rangliste (alle kan se)
• \`/motivate-now\` - Admin: Send motivation nu
• \`/show-ideas\` - Admin: Visuelt overblik

**🏷️ Kategorier:**
🤖 AI & Automatisering • 🔗 Integrationer • ⚙️ Procesoptimering
📊 Data & Visualisering • 🎨 UI/UX • 💡 Kreative Løsninger

**💡 Tips:**
• Vær specifik i dine idé-beskrivelser
• Byg videre på andres idéer
• Brug /hackathon-stats for at se fremgang
• Check /leaderboard for at se din ranking

**🚀 Ready to innovate? Start med "Ide:" og lad kreativiteten flyde!**
  `;
  
  await respond({
    text: helpMessage,
    response_type: 'ephemeral'
  });
});

// VISUAL EXPORT COMMAND - Flot visuelt output direkte i Slack
app.command('/show-ideas', async ({ command, ack, respond }) => {
  const requestId = generateRequestId();
  await ack();
  
  try {
    // Kun admin kan vise alle idéer
    if (command.user_id !== CONFIG.adminUserId) {
      await respond({
        text: '❌ Kun admin kan vise alle idéer!',
        response_type: 'ephemeral'
      });
      return;
    }
    
    logWithContext('info', 'Visual ideas export requested', { requestId, adminId: command.user_id });
    
    await respond({
      text: '🎨 Genererer visuelt overblik... ⏳',
      response_type: 'ephemeral'
    });
    
    // Hent alle idéer med detaljeret information
    const ideasQuery = `
      SELECT 
        i.id,
        i.username,
        i.idea_text,
        i.category,
        i.created_at,
        COUNT(r.id) as reaction_count
      FROM ideas i
      LEFT JOIN reactions r ON i.id = r.idea_id
      GROUP BY i.id, i.username, i.idea_text, i.category, i.created_at
      ORDER BY i.created_at DESC
    `;
    
    const result = await executeWithRetry(async () => {
      return await pool.query(ideasQuery);
    });
    
    const ideas = result.rows;
    
    if (ideas.length === 0) {
      await respond({
        text: '⚠️ Ingen idéer at vise endnu!',
        response_type: 'ephemeral',
        replace_original: true
      });
      return;
    }
    
    // Generer statistikker
    const totalIdeas = ideas.length;
    const uniqueUsers = new Set(ideas.map(i => i.username)).size;
    const totalReactions = ideas.reduce((sum, idea) => sum + parseInt(idea.reaction_count), 0);
    
    // Kategori statistikker
    const categoryStats = ideas.reduce((acc, idea) => {
      acc[idea.category] = (acc[idea.category] || 0) + 1;
      return acc;
    }, {});
    
    // Top brugere
    const userStats = ideas.reduce((acc, idea) => {
      acc[idea.username] = (acc[idea.username] || 0) + 1;
      return acc;
    }, {});
    
    const topUsers = Object.entries(userStats)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5);
    
    // Daglig aktivitet
    const dailyStats = ideas.reduce((acc, idea) => {
      const date = new Date(idea.created_at).toLocaleDateString('da-DK');
      acc[date] = (acc[date] || 0) + 1;
      return acc;
    }, {});
    
    // Generér visuelt overblik
    const visualOverview = {
      "blocks": [
        {
          "type": "header",
          "text": {
            "type": "plain_text",
            "text": "🚀 Forteil Hackathon - Idé Overblik",
            "emoji": true
          }
        },
        {
          "type": "section",
          "fields": [
            {
              "type": "mrkdwn",
              "text": `*📊 Total Idéer:*\n${totalIdeas}`
            },
            {
              "type": "mrkdwn",
              "text": `*👥 Aktive Brugere:*\n${uniqueUsers}`
            },
            {
              "type": "mrkdwn",
              "text": `*💬 Total Reaktioner:*\n${totalReactions}`
            },
            {
              "type": "mrkdwn",
              "text": `*📈 Gennemsnit per Bruger:*\n${(totalIdeas / uniqueUsers).toFixed(1)}`
            }
          ]
        },
        {
          "type": "divider"
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*🏷️ Kategori Fordeling:*\n${Object.entries(categoryStats)
              .sort(([,a], [,b]) => b - a)
              .map(([cat, count]) => `${cat}: ${count} idéer (${Math.round(count/totalIdeas*100)}%)`)
              .join('\n')}`
          }
        },
        {
          "type": "divider"
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*🏆 Top Idé-Generatorer:*\n${topUsers
              .map(([user, count], index) => `${index + 1}. *${user}*: ${count} idéer`)
              .join('\n')}`
          }
        },
        {
          "type": "divider"
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": `*📅 Daglig Aktivitet:*\n${Object.entries(dailyStats)
              .sort(([a], [b]) => new Date(a.split('.').reverse().join('-')) - new Date(b.split('.').reverse().join('-')))
              .map(([date, count]) => `${date}: ${count} idéer`)
              .join('\n')}`
          }
        },
        {
          "type": "divider"
        }
      ]
    };
    
    // Tilføj de seneste idéer som separate blocks
    const recentIdeas = ideas.slice(0, 10); // Vis de 10 seneste
    
    visualOverview.blocks.push({
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": `*💡 Seneste ${Math.min(10, ideas.length)} Idéer:*`
      }
    });
    
    recentIdeas.forEach((idea, index) => {
      const date = new Date(idea.created_at);
      const timeAgo = getTimeAgo(date);
      
      visualOverview.blocks.push({
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `*${index + 1}.* ${idea.idea_text.substring(0, 100)}${idea.idea_text.length > 100 ? '...' : ''}\n_${idea.category} • ${idea.username} • ${timeAgo} • ${idea.reaction_count} reaktioner_`
        }
      });
    });
    
    // Tilføj footer
    visualOverview.blocks.push(
      {
        "type": "divider"
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": `📊 Genereret: ${new Date().toLocaleString('da-DK', {timeZone: 'Europe/Copenhagen'})} | 🤖 Forteil Hackathon Bot v2.0`
          }
        ]
      }
    );
    
    await respond({
      "replace_original": true,
      "response_type": "ephemeral",
      ...visualOverview
    });
    
    logWithContext('info', 'Visual ideas export completed', { 
      requestId, 
      totalIdeas,
      uniqueUsers,
      totalReactions
    });
    
  } catch (error) {
    logWithContext('error', 'Visual ideas export failed', { requestId, error: error.message });
    await respond({
      text: `❌ **Visuelt overblik fejlede:**\n\n\`\`\`${error.message}\`\`\``,
      response_type: 'ephemeral',
      replace_original: true
    });
  }
});

// Helper function til "time ago" formatting
function getTimeAgo(date) {
  const now = new Date();
  const diffInSeconds = Math.floor((now - date) / 1000);
  
  if (diffInSeconds < 60) return 'lige nu';
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} min siden`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} timer siden`;
  if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)} dage siden`;
  return date.toLocaleDateString('da-DK');
}

// LIVE LEADERBOARD COMMAND - Real-time leaderboard
app.command('/leaderboard', async ({ command, ack, respond }) => {
  const requestId = generateRequestId();
  await ack();
  
  try {
    logWithContext('info', 'Leaderboard requested', { requestId, userId: command.user_id });
    
    // Hent leaderboard data  
    const leaderboardQuery = `
      SELECT 
        username,
        COUNT(*) as idea_count,
        STRING_AGG(DISTINCT category, ', ') as categories,
        MAX(created_at) as last_idea,
        AVG(reaction_count) as avg_reactions
      FROM (
        SELECT 
          i.username,
          i.category,
          i.created_at,
          COUNT(r.id) as reaction_count
        FROM ideas i
        LEFT JOIN reactions r ON i.id = r.idea_id
        GROUP BY i.id, i.username, i.category, i.created_at
      ) stats
      GROUP BY username
      ORDER BY idea_count DESC, last_idea DESC
      LIMIT 10
    `;
    
    const result = await executeWithRetry(async () => {
      return await pool.query(leaderboardQuery);
    });
    
    const leaderboard = result.rows;
    
    if (leaderboard.length === 0) {
      await respond({
        text: '📊 Ingen data til leaderboard endnu!\n\nStart med at poste en idé: `Ide: Min fantastiske idé`',
        response_type: 'ephemeral'
      });
      return;
    }
    
    // Generer emoji trofæer
    const getTrophy = (index) => {
      if (index === 0) return '🏆';
      if (index === 1) return '🥈';
      if (index === 2) return '🥉';
      return '🏅';
    };
    
    const leaderboardBlocks = {
      "blocks": [
        {
          "type": "header",
          "text": {
            "type": "plain_text",
            "text": "🏆 Hackathon Leaderboard",
            "emoji": true
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": "_Live ranking af idé-generatorer! 🚀_"
          }
        },
        {
          "type": "divider"
        }
      ]
    };
    
    leaderboard.forEach((user, index) => {
      const trophy = getTrophy(index);
      const lastIdea = new Date(user.last_idea);
      const timeAgo = getTimeAgo(lastIdea);
      
      leaderboardBlocks.blocks.push({
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `${trophy} *${index + 1}. ${user.username}*\n📊 ${user.idea_count} idéer • 🏷️ ${user.categories}\n⏰ Seneste: ${timeAgo} • 💬 Ø ${parseFloat(user.avg_reactions || 0).toFixed(1)} reaktioner`
        }
      });
    });
    
    // Tilføj motivation footer
    const motivationMessages = [
      "🚀 Kom i gang med: `Ide: Din fantastiske idé her`",
      "💡 Brug `/hackathon-help` for at se alle commands",
      "🎯 Mål: 50+ idéer til hackathon!",
      "⚡ Jo flere idéer, jo bedre hackathon!"
    ];
    
    leaderboardBlocks.blocks.push(
      {
        "type": "divider"
      },
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": motivationMessages[Math.floor(Math.random() * motivationMessages.length)]
        }
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": `🔄 Opdateret: ${new Date().toLocaleTimeString('da-DK', {timeZone: 'Europe/Copenhagen'})} | Brug \`/leaderboard\` for at opdatere`
          }
        ]
      }
    );
    
    await respond({
      "response_type": "in_channel", // Synlig for alle - skaber konkurrence!
      ...leaderboardBlocks
    });
    
    logWithContext('info', 'Leaderboard displayed', { 
      requestId,
      totalUsers: leaderboard.length,
      topUser: leaderboard[0]?.username
    });
    
  } catch (error) {
    logWithContext('error', 'Leaderboard failed', { requestId, error: error.message });
    await respond({
      text: `❌ Leaderboard kunne ikke indlæses: ${error.message}`,
      response_type: 'ephemeral'
    });
  }
});

// Daily motivation cron with enhanced error handling
cron.schedule('0 9 * * *', async () => {
  const requestId = generateRequestId();
  
  try {
    logWithContext('info', 'Daily cron job triggered', { requestId });
    
    if (!process.env.HACKATHON_CHANNEL_ID) {
      logWithContext('warn', 'No HACKATHON_CHANNEL_ID set, skipping daily post', { requestId });
      return;
    }
    
    const stats = await getIdeaStats(requestId);
    
    if (!stats || stats.total === 0) {
      logWithContext('info', 'No ideas available, skipping daily post', { requestId });
      return;
    }
    
    const dailyMessage = generateMotivationalMessage(stats);
    
    await app.client.chat.postMessage({
      channel: process.env.HACKATHON_CHANNEL_ID,
      text: dailyMessage
    });
    
    logWithContext('info', 'Daily motivational message sent successfully', { 
      requestId, 
      totalIdeas: stats.total 
    });
    
  } catch (error) {
    logWithContext('error', 'Daily cron job failed', { 
      requestId, 
      error: error.message,
      stack: error.stack
    });
    
    // Send alert to admin on critical failure
    try {
      if (process.env.HACKATHON_CHANNEL_ID) {
        await app.client.chat.postMessage({
          channel: CONFIG.adminUserId, // Send DM to admin
          text: `🚨 **Daily Motivation Cron Failed**\n\nTime: ${new Date().toISOString()}\nError: ${error.message}\n\nRequest ID: ${requestId}`
        });
      }
    } catch (alertError) {
      logWithContext('error', 'Failed to send admin alert', { requestId, error: alertError.message });
    }
  }
}, {
  timezone: "Europe/Copenhagen"
});

// Database initialization with comprehensive setup
const initDB = async () => {
  try {
    logWithContext('info', 'Initializing database');
    
    const createIdeasTable = `
      CREATE TABLE IF NOT EXISTS ideas (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        username VARCHAR(255) NOT NULL,
        idea_text TEXT NOT NULL,
        category VARCHAR(255) NOT NULL,
        message_ts VARCHAR(255) NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        
        CONSTRAINT ideas_message_ts_unique UNIQUE(message_ts, channel_id)
      )
    `;
    
    const createReactionsTable = `
      CREATE TABLE IF NOT EXISTS reactions (
        id SERIAL PRIMARY KEY,
        idea_id INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
        reaction_type VARCHAR(50) NOT NULL,
        response_text TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;
    
    const createIndexes = `
      CREATE INDEX IF NOT EXISTS idx_ideas_created_at ON ideas(created_at);
      CREATE INDEX IF NOT EXISTS idx_ideas_category ON ideas(category);
      CREATE INDEX IF NOT EXISTS idx_ideas_user_id ON ideas(user_id);
      CREATE INDEX IF NOT EXISTS idx_reactions_idea_id ON reactions(idea_id);
    `;
    
    await pool.query(createIdeasTable);
    await pool.query(createReactionsTable);
    await pool.query(createIndexes);
    
    logWithContext('info', 'Database tables and indexes created/verified');
    
    // Test database with health check
    await pool.query('SELECT 1');
    logWithContext('info', 'Database connection test successful');
    
  } catch (error) {
    logWithContext('error', 'Database initialization failed', { 
      error: error.message,
      stack: error.stack 
    });
    throw error;
  }
};

// Enhanced startup with comprehensive error handling
(async () => {
  try {
    logWithContext('info', 'Starting Forteil Hackathon Bot v2.0.0');
    
    // Validate required environment variables
    const requiredEnvVars = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'DATABASE_URL'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
    
    await initDB();
    await app.start();
    
    logWithContext('info', 'Forteil Hackathon Bot started successfully', {
      port: process.env.PORT || 3000,
      environment: process.env.NODE_ENV || 'development',
      adminUser: CONFIG.adminUserId,
      dadJokeChance: CONFIG.dadJokeChance
    });
    
  } catch (error) {
    logWithContext('error', 'Failed to start application', { 
      error: error.message,
      stack: error.stack 
    });
    process.exit(1);
  }
})();

module.exports = { app, pool };

// Periodic cleanup of rate limit store
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of rateLimitStore.entries()) {
    const validTimestamps = timestamps.filter(time => now - time < CONFIG.rateLimitWindow);
    if (validTimestamps.length === 0) {
      rateLimitStore.delete(userId);
    } else {
      rateLimitStore.set(userId, validTimestamps);
    }
  }
}, CONFIG.rateLimitWindow);