'use strict';

function isParentEmailOperation(req) {
  const method = String(req.method || '').toUpperCase();
  const path = String(req.path || '');
  if (method === 'GET' && /^\/api\/projects\/\d+\/email\/queue$/.test(path)) return true;
  if (method === 'POST' && /^\/api\/projects\/\d+\/email\/(?:preview|send-all|queue\/\d+\/(?:remove|retry|retry-unresolved))$/.test(path)) {
    return true;
  }
  if (method === 'POST' && /^\/api\/students\/\d+\/resend-gallery-email$/.test(path)) return true;
  return method === 'POST' && /^\/api\/email\/(?:send|test)$/.test(path);
}

function normalizeHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  return /[/:,\s]/.test(hostname) ? '' : hostname;
}

function parentEmailOperationGuard(req, res, next) {
  if (!isParentEmailOperation(req)) return next();

  const publishedHost = normalizeHostname(process.env.PARENT_EMAIL_PUBLISHED_HOST);
  const requestHost = normalizeHostname(req.hostname);
  if (!publishedHost || !requestHost || requestHost !== publishedHost) {
    return res.status(503).json({
      error: 'Parent email operations are disabled for this hostname. Configure PARENT_EMAIL_PUBLISHED_HOST to the exact Published hostname in the GoDaddy Node.js application environment settings; Preview requests must use a different hostname.'
    });
  }
  return next();
}

module.exports = {
  isParentEmailOperation,
  parentEmailOperationGuard
};
