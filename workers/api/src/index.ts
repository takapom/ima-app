type HealthResponse = {
  readonly status: 'ok';
};

export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/health') {
      const body: HealthResponse = { status: 'ok' };
      return Response.json(body);
    }
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler;
