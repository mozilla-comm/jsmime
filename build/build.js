var fs = require('fs'),
    path = require('path'),
    dir = __dirname,
    distDir = path.join(dir, '..', 'dist');
    distPath = path.join(distDir, 'jsmime.js'),
    defineRegExp = /define\(/,
    modules = [
      'mimeutils',
      'structuredHeaders',
      'headerparser',
      'mimeparser',
      'headeremitter',
      'jsmime'
    ],
    pre = fs.readFileSync(path.join(dir, 'pre.txt'), 'utf8'),
    post = fs.readFileSync(path.join(dir, 'post.txt'), 'utf8'),
    contents = pre;

modules.forEach(function(mod) {
  var text = fs.readFileSync(path.join(dir, '..', mod + '.js'), 'utf8');
  text = text.replace(defineRegExp, "def('" + mod + "', ");
  contents += text;
});

contents += post;

if (!fs.existsSync(distDir)) {
  fs.mkdir(distDir, 511);
}

fs.writeFileSync(distPath, contents, 'utf8');
