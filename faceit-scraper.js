// faceit-scraper.js
const axios = require('axios');
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
require('dotenv').config(); // Load environment variables from .env file

// Configure these values (from .env file or directly)
const FACEIT_API_KEY = process.env.FACEIT_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
const SHEET_NAME = 'BotAccounts';

// Patterns to search for
const PATTERNS = [
  '---TAKE',
  '---hiELO',
  '---MyELO',
  '---ggELO',
  '---ELObst',
  '---ELOg0d',
  '---GOTIt',
  '---topELO',
  '---TakeIt',
  '---ELOizi',
  '---oELO',
  '---youELO',
  '---ELOOO',
  '---Up-ELO'
];

// Faceit API client
const faceitClient = axios.create({
  baseURL: 'https://open.faceit.com/data/v4',
  headers: {
    'Authorization': `Bearer ${FACEIT_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

// Initialize Google Sheets API with direct credentials
async function getGoogleSheetsClient() {
  // Create JWT client using the provided credentials
  const jwtClient = new JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  // Authenticate
  await jwtClient.authorize();

  // Return configured sheets client
  return google.sheets({ version: 'v4', auth: jwtClient });
}

// Search for users with a specific pattern
async function searchUsers(pattern, offset = 0, limit = 100) {
  try {
    const response = await faceitClient.get('/search/players', {
      params: {
        nickname: pattern,
        offset,
        limit
      }
    });

    return response.data;
  } catch (error) {
    console.error(`Error searching for pattern ${pattern}:`, error.message);
    return { items: [], start: 0, end: 0, from: 0, to: 0 };
  }
}

// Extract all users for a pattern (handles pagination)
async function getAllUsersForPattern(pattern) {
  console.log(`Searching for pattern: ${pattern}`);

  let offset = 0;
  const limit = 100;
  let allUsers = [];
  let hasMore = true;

  while (hasMore) {
    const result = await searchUsers(pattern, offset, limit);

    if (result.items && result.items.length > 0) {
      allUsers = [...allUsers, ...result.items];
      offset += limit;

      // Check if we've reached the end
      hasMore = result.items.length === limit;

      // Add a delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 500));

      console.log(`Found ${allUsers.length} accounts so far for pattern ${pattern}...`);
    } else {
      hasMore = false;
    }
  }

  // Only return nickname and player_id
  return allUsers.map(user => ({
    nickname: user.nickname,
    userId: user.player_id
  }));
}

// Initialize or clear the spreadsheet
async function initializeSpreadsheet(sheetsClient) {
  try {
    // Check if the sheet exists
    await sheetsClient.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      ranges: [SHEET_NAME]
    });

    // Clear existing content
    await sheetsClient.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:B`
    });

    console.log(`Cleared existing content in sheet: ${SHEET_NAME}`);
  } catch (error) {
    console.log(`Sheet ${SHEET_NAME} doesn't exist, creating it...`);

    // Create the sheet if it doesn't exist
    try {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [{
            addSheet: {
              properties: {
                title: SHEET_NAME
              }
            }
          }]
        }
      });
      console.log(`Created new sheet: ${SHEET_NAME}`);
    } catch (createError) {
      console.error(`Error creating sheet: ${createError.message}`);
      throw createError;
    }
  }

  // Add headers
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:B1`,
    valueInputOption: 'RAW',
    resource: {
      values: [['User ID', 'Nickname']]
    }
  });

  console.log('Added headers to the spreadsheet');
}

// Write users to Google Sheets
async function writeUsersToSheet(sheetsClient, users) {
  if (users.length === 0) {
    console.log('No users to write to the spreadsheet');
    return;
  }

  const rows = users.map(user => [
    user.userId,
    user.nickname
  ]);

  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:B`,
      valueInputOption: 'RAW',
      resource: {
        values: rows
      }
    });

    console.log(`Successfully added ${users.length} accounts to the spreadsheet.`);
  } catch (error) {
    console.error(`Error writing to spreadsheet: ${error.message}`);
    throw error;
  }
}

// Main function
async function main() {
  try {
    console.log('Starting Faceit account scraper...');
    console.log(`Using Faceit API key: ${FACEIT_API_KEY.slice(0, 5)}...`);
    console.log(`Using spreadsheet ID: ${SPREADSHEET_ID}`);

    // Initialize Google Sheets
    console.log('Authenticating with Google...');
    const sheetsClient = await getGoogleSheetsClient();
    console.log('Google authentication successful');

    // Initialize spreadsheet
    await initializeSpreadsheet(sheetsClient);

    let totalAccounts = 0;

    // Process each pattern and save results after each pattern
    console.log('Starting pattern search...');
    for (const pattern of PATTERNS) {
      const users = await getAllUsersForPattern(pattern);

      if (users.length > 0) {
        console.log(`Found ${users.length} accounts for pattern "${pattern}". Writing to spreadsheet...`);
        await writeUsersToSheet(sheetsClient, users);
        totalAccounts += users.length;
      } else {
        console.log(`No accounts found for pattern "${pattern}".`);
      }

      // Add delay between patterns to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Now also search for numeric patterns (---TAKE_1 through ---TAKE_200)
    // Limiting to 200 for efficiency, you can increase this
    console.log('Starting numeric pattern search...');

    // Process in batches of 10 to avoid overwhelming the API
    for (let batch = 1; batch <= 20; batch++) {
      const startNumber = (batch - 1) * 10 + 1;
      const endNumber = batch * 10;

      console.log(`Searching batch ${batch}: ---TAKE_${startNumber} to ---TAKE_${endNumber}`);

      for (let i = startNumber; i <= endNumber; i++) {
        const pattern = `---TAKE_${i}`;
        const users = await getAllUsersForPattern(pattern);

        if (users.length > 0) {
          console.log(`Found ${users.length} accounts for pattern "${pattern}". Writing to spreadsheet...`);
          await writeUsersToSheet(sheetsClient, users);
          totalAccounts += users.length;
        }

        // Add a small delay to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      console.log(`Completed batch ${batch}. Total accounts so far: ${totalAccounts}`);
    }

    console.log(`Completed! Found and saved ${totalAccounts} accounts total.`);

  } catch (error) {
    console.error('Error in main process:', error);
  }
}

// Run the main function
main().then(() => {
  console.log('Script execution finished.');
}).catch(error => {
  console.error('Unhandled error:', error);
});
