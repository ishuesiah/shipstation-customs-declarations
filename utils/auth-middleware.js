// Authentication middleware utilities

// API-only auth (JSON 401)
const requireAuthApi = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
};

// Page guard (redirect to /login)
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

module.exports = {
  requireAuth,
  requireAuthApi
};
