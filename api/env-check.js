// Temporary diagnostic endpoint - remove after debugging
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  
  const ghlToken = process.env.GHL_TOKEN || 'NOT_SET';
  const voiceToken = process.env.GHL_VOICE_TOKEN || 'NOT_SET';
  
  return res.status(200).json({
    GHL_TOKEN_prefix: ghlToken.substring(0, 20) + '...',
    GHL_VOICE_TOKEN_prefix: voiceToken.substring(0, 20) + '...',
    GHL_LOCATION_ID: process.env.GHL_LOCATION_ID || 'NOT_SET',
    FIRECRAWL_set: !!process.env.FIRECRAWL_API_KEY,
  });
}
