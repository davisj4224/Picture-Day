'use strict';

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Administrator access is required.' });
  return res.redirect('/login');
}

module.exports = { requireAdmin };
