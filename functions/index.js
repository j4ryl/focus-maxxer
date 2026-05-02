import { onRequest } from 'firebase-functions/v2/https';

const transcriptionModel = 'gpt-4o-mini-transcribe';

export const realtimeToken = onRequest({ cors: true, region: 'asia-southeast1' }, async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.status(204).send('');
    return;
  }

  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    response.status(500).json({ error: 'OPENAI_API_KEY is not configured for the function' });
    return;
  }

  const tokenResponse = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expires_after: {
        anchor: 'created_at',
        seconds: 600,
      },
      session: {
        type: 'transcription',
        audio: {
          input: {
            noise_reduction: {
              type: 'far_field',
            },
            transcription: {
              model: transcriptionModel,
              language: 'en',
              prompt: 'University lecture audio. Prefer concise, readable live captions.',
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.45,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
        },
      },
    }),
  });

  const payload = await tokenResponse.json().catch(() => ({}));

  if (!tokenResponse.ok) {
    response.status(tokenResponse.status).json({
      error: payload.error?.message || 'Unable to create OpenAI Realtime token',
    });
    return;
  }

  response.json({
    client_secret: payload.client_secret?.value || payload.value,
    expires_at: payload.client_secret?.expires_at || payload.expires_at,
    model: transcriptionModel,
  });
});
