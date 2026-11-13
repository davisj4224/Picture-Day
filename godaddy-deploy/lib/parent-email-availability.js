'use strict';

function isParentEmailOperation(req) {
  const method = String(req.method || '').toUpperCase();
  const path = String(req.path || '');
  if (method === 'GET' && /^\/api\/projects\/\d+\/email\/queue$/.test(path)) return true;
  if (method === 'POST' && /^\/api\/projects\/\d+\/email\/(?:preview|send|send-all|queue\/\d+\/(?:remove|retry|retry-unresolved))$/.test(path)) {
    return true;
  }
  if (method === 'POST' && /^\/api\/students\/\d+\/resend-gallery-email$/.test(path)) return true;
  return method === 'POST' && /^\/api\/email\/(?:send|test)$/.test(path);
}

function normalizeHostname(value) {
  const configured = String(value || '').trim();
  if (!configured) return '';
  try {
    const url = new URL(configured.includes('://') ? configured : `https://${configured}`);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) return '';
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function parentEmailOperationGuard(req, res, next, configuredPublishedUrl = '') {
  if (!isParentEmailOperation(req)) return next();

  const publishedHost = normalizeHostname(process.env.PARENT_EMAIL_PUBLISHED_HOST || configuredPublishedUrl);
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
