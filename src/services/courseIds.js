const courses = require('../../data/courses.json');

module.exports = new Set(courses.map((c) => c.id));
