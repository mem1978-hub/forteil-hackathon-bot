// SIMPLIFIED VERSION - app.js
const { App } = require('@slack/bolt');
const { Pool } = require('pg');
const cron = require('node-cron');
require('dotenv').config();

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  port: process.env.PORT || 3000
});

// Vittige svar og reactions
const funnyResponses = [
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

const dadJokes = [
  "Hvorfor elsker programmører mørke? Fordi lys tiltrækker bugs! 🐛",
  "Hvad siger en AI når den er træt? 'Jeg trænger til at reboote!' 💤",
  "Hvorfor gik API'et til tandlægen? Det havde dårlige endpoints! 🦷",
  "Hvad kalder man en hacker der laver kaffe? En Java developer! ☕",
  "Hvorfor blev robotten fyret? Den havde for mange glitches i sin performance review! 🤖"
];

const reactions = ['rocket', 'bulb', 'zap', 'dart', 'fire', 'gem', 'star', 'clap', 'tada', 'muscle'];

// Categorization logic
const categorizeIdea = (text) => {
  const lowerText = text.toLowerCase();
  
  if (lowerText.includes('ai') || lowerText.includes('chatbot') || lowerText.includes('automatiser')) {
    return { name: '🤖 AI & Automatisering', emoji: 'robot_face' };
  } else if (lowerText.includes('slack') || lowerText.includes('integration') || lowerText.includes('api')) {
    return { name: '🔗 Integrationer', emoji: 'link' };
  } else if (lowerText.includes('process') || lowerText.includes('workflow') || lowerText.includes('effektiv')) {
    return { name: '⚙️ Procesoptimering', emoji: 'gear' };
  } else if (lowerText.includes('dashboard') || lowerText.includes('rapporter') || lowerText.includes('data')) {
    return { name: '📊 Data & Visualisering', emoji: 'bar_chart' };
  } else {
    return { name: '💡 Kreative Løsninger', emoji: 'bulb' };
  }
};

// Database functions
const saveIdea = async (userId, username, text, category, messageTs, channelId) => {
  try {
    const query = `
      INSERT INTO ideas (user_id, username, idea_text, category, message_ts, channel_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING id
    `;
    const result = await pool.query(query, [userId, username, text, category, messageTs, channelId]);
    return result.rows[0].id;
  } catch (error) {
    console.error('Error saving idea:', error);
    return null;
  }
};

const saveReaction = async (ideaId, reactionType, responseText) => {
  try {
    const query = `
      INSERT INTO reactions (idea_id, reaction_type, response_text, created_at)
      VALUES ($1, $2, $3, NOW())
    `;
    await pool.query(query, [ideaId, reactionType, responseText]);
  } catch (error) {
    console.error('Error saving reaction:', error);
  }
};

const getIdeaStats = async () => {
  try {
    const totalQuery = 'SELECT COUNT(*) as total FROM ideas';
    const categoryQuery = `
      SELECT category, COUNT(*) as count 
      FROM ideas 
      GROUP BY category 
      ORDER BY count DESC
    `;
    const topUsersQuery = `
      SELECT username, COUNT(*) as idea_count 
      FROM ideas 
      GROUP BY username 
      ORDER BY idea_count DESC 
      LIMIT 5
    `;
    
    const [total, categories, topUsers] = await Promise.all([
      pool.query(totalQuery),
      pool.query(categoryQuery),
      pool.query(topUsersQuery)
    ]);
    
    return {
      total: total.rows[0].total,
      categories: categories.rows,
      topUsers: topUsers.rows
    };
  } catch (error) {
    console.error('Error getting stats:', error);
    return null;
  }
};

// Main message handler
app.message(async ({ message, client }) => {
  // Ignorer bot beskeder
  if (message.bot_id) {
    return;
  }

  // Kun reagér i hackathon kanalen (hvis defineret)
  if (process.env.HACKATHON_CHANNEL_ID && message.channel !== process.env.HACKATHON_CHANNEL_ID) {
    return;
  }

  // Kun reagér på beskeder der starter med "Ide" (case insensitive)
  if (!message.text || !message.text.toLowerCase().startsWith('ide')) {
    return;
  }

  try {
    console.log(`Processing idea from user ${message.user}: ${message.text}`);
    
    // Get real username
    let username = 'Anonymous';
    try {
      const userInfo = await client.users.info({ user: message.user });
      username = userInfo.user.display_name || userInfo.user.real_name || userInfo.user.name || 'Anonymous';
    } catch (error) {
      console.log('Could not fetch user info, using Anonymous');
    }
    
    // Categorize idea
    const category = categorizeIdea(message.text);
    
    // Save to database with real username
    const ideaId = await saveIdea(
      message.user,
      username,
      message.text,
      category.name,
      message.ts,
      message.channel
    );
    
    console.log(`Saved idea with ID: ${ideaId} from ${username}`);
    
    // Add random reaction
    const randomReaction = reactions[Math.floor(Math.random() * reactions.length)];
    await client.reactions.add({
      channel: message.channel,
      timestamp: message.ts,
      name: randomReaction
    });
    
    // Add category reaction
    await client.reactions.add({
      channel: message.channel,
      timestamp: message.ts,
      name: category.emoji
    });
    
    console.log('Added reactions successfully');
    
    // Wait for dramatic effect
    setTimeout(async () => {
      const randomResponse = funnyResponses[Math.floor(Math.random() * funnyResponses.length)];
      
      await client.chat.postMessage({
        channel: message.channel,
        text: randomResponse,
        thread_ts: message.ts
      });
      
      console.log('Sent response successfully');
      
      // Save reaction to database
      if (ideaId) {
        await saveReaction(ideaId, 'response', randomResponse);
      }
      
      // 25% chance for dad joke
      if (Math.random() < 0.25) {
        setTimeout(async () => {
          const randomJoke = dadJokes[Math.floor(Math.random() * dadJokes.length)];
          await client.chat.postMessage({
            channel: message.channel,
            text: `Bonus dad joke: ${randomJoke}`,
            thread_ts: message.ts
          });
          
          if (ideaId) {
            await saveReaction(ideaId, 'dad_joke', randomJoke);
          }
        }, 2000);
      }
      
    }, Math.random() * 3000 + 1000);
    
  } catch (error) {
    console.error('Error handling message:', error);
  }
});

// Slash command for stats
app.command('/hackathon-stats', async ({ command, ack, respond }) => {
  await ack();
  
  try {
    const stats = await getIdeaStats();
    
    if (!stats) {
      await respond('Ups! Kunne ikke hente statistikker. Prøv igen senere! 🤖💥');
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
    
  } catch (error) {
    console.error('Error in stats command:', error);
    await respond('Ups! Noget gik galt. Prøv igen! 🤖');
  }
});

// Daily stats posting (kl. 9:00 hver dag)
cron.schedule('0 9 * * *', async () => {
  if (!process.env.HACKATHON_CHANNEL_ID) return;
  
  try {
    const stats = await getIdeaStats();
    if (!stats || stats.total === 0) return;
    
    const motivationalMessages = [
      `🌅 God morgen, idé-maskiner, alle jer vidunderlige Forteilees! Vi har ${stats.total} fantastiske idéer indtil nu!`,
      `☕ Kaffe-tid! Vores idé-tæller står på ${stats.total} - skal vi runde op, kære Forteilees?`,
      `🧠 Dagens brainstorm-update: ${stats.total} idéer og counting, fantastiske Forteilees!`,
      `⚡ Lightning round! Vi har ${stats.total} idéer - hvad kommer der næst, dygtige Forteilees?`,
      `🎯 Målrettet opdatering: ${stats.total} idéer på tavlen, vidunderlige Forteilees!`
    ];
    
    const randomMessage = motivationalMessages[Math.floor(Math.random() * motivationalMessages.length)];
    
    // Get most popular category
    const topCategory = stats.categories.length > 0 ? stats.categories[0] : null;
    const categoryText = topCategory ? 
      `\n🏆 Mest populære kategori: ${topCategory.category} (${topCategory.count} idéer)` : '';
    
    await app.client.chat.postMessage({
      channel: process.env.HACKATHON_CHANNEL_ID,
      text: `${randomMessage}${categoryText}\n\n💡 Brug /hackathon-stats for fuld oversigt!\n\n<!channel> Få delt flere idéer! 🚀`
    });
    
  } catch (error) {
    console.error('Error sending daily stats:', error);
  }
});

// Initialize database
const initDB = async () => {
  try {
    const createIdeasTable = `
      CREATE TABLE IF NOT EXISTS ideas (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        username VARCHAR(255) NOT NULL,
        idea_text TEXT NOT NULL,
        category VARCHAR(255) NOT NULL,
        message_ts VARCHAR(255) NOT NULL,
        channel_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;
    
    const createReactionsTable = `
      CREATE TABLE IF NOT EXISTS reactions (
        id SERIAL PRIMARY KEY,
        idea_id INTEGER REFERENCES ideas(id),
        reaction_type VARCHAR(50) NOT NULL,
        response_text TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;
    
    await pool.query(createIdeasTable);
    await pool.query(createReactionsTable);
    
    console.log('✅ Database tables created/verified');
  } catch (error) {
    console.error('❌ Error initializing database:', error);
  }
};

// Start the app
(async () => {
  try {
    await initDB();
    await app.start();
    console.log('⚡️ Forteil Hackathon Idé-Bot er i gang på port', process.env.PORT || 3000);
  } catch (error) {
    console.error('❌ Failed to start app:', error);
  }
})();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

module.exports = { app };