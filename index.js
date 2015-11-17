var Promise = require("bluebird");
var AWS = require('aws-sdk');
var matter = require('gray-matter');
var md = require('markdown-it')();
var yaml = require('js-yaml');
var Mustache = require('mustache');
var extend = require('util')._extend;

// XXX startsWith polyfill.
// XXX Put this somewhere else...
if (!String.prototype.startsWith) {
  String.prototype.startsWith = function(searchString, position) {
    position = position || 0;
    return this.indexOf(searchString, position) === position;
  };
}

// XXX endsWith polyfill.
// XXX Put this somewhere else...
if (!String.prototype.endsWith) {
  String.prototype.endsWith = function(searchString, position) {
      var subjectString = this.toString();
      if (typeof position !== 'number' || !isFinite(position) || Math.floor(position) !== position || position > subjectString.length) {
        position = subjectString.length;
      }
      position -= searchString.length;
      var lastIndex = subjectString.indexOf(searchString, position);
      return lastIndex !== -1 && lastIndex === position;
  };
}

function MyS3(in_bucket, out_type) {
  this.in_bucket = in_bucket;
  this.out_type = out_type;

  this.s3 = new AWS.S3();
  Promise.promisifyAll(Object.getPrototypeOf(this.s3));

  this.get_config = function() {
    return this.get_file('scampish_config.yaml').bind(this)
      .then(function(file) {
        return yaml.safeLoad(file.Body);
      })
      .then(function(obj) {
        this.config = obj;
        this.out_bucket = obj.buckets[this.out_type];
        // XXX Throw an error if this doesn't work.
      });
  };

  this.get_dir_listing = function(prefix) {
    if (!prefix.endsWith('/')) {
      prefix = prefix + '/';
    }

    var params = {
      Bucket: this.in_bucket,
      Delimiter: '/',
      Prefix: prefix
    };
    return this.s3.listObjectsAsync(params);
  };

  this.get_file = function(key) {
    var params = {
      Bucket: this.in_bucket,
      Key: key
    };
    return this.s3.getObjectAsync(params);
  };

  // XXX Add cache control header.
  // XXX Add gzip?

  this.copy_static = function(in_filename, out_filename) {
    out_filename = out_filename.replace(/^\/+/, '');
    in_filename = this.in_bucket + '/' + in_filename;
    console.log("copy static", in_filename, "to",
                this.out_bucket + '/' + out_filename);

    var params = {
      Bucket: this.out_bucket,
      CopySource: in_filename,
      Key: out_filename,
      ACL: 'public-read',
      StorageClass: 'REDUCED_REDUNDANCY'
    };
    return this.s3.copyObjectAsync(params);
  };

  this.upload = function(out_filename, html) {
    out_filename = out_filename.replace(/^\/+/, '');
    console.log("upload", this.out_bucket + '/' + out_filename);

    var params = {
      Bucket: this.out_bucket,
      Key: out_filename,
      Body: html,
      ContentType: 'text/html; charset=UTF-8',
      ACL: 'public-read',
      StorageClass: 'REDUCED_REDUNDANCY',
      CacheControl: 'max-age=86400, public'
    };
    return this.s3.uploadAsync(params);
  };
}

function Renderer(mys3) {
  this.mys3 = mys3;

  this.templates = {};
  this.templates_loaded = false;

  this.get_template = function(key) {
    console.log("get_template", key);
    return this.mys3.get_file(key).bind(this)
      .then(function(data) {
        // console.log("Template s3:", data);
        var name = key.slice(key.lastIndexOf('/') + 1, key.lastIndexOf('.'));
        this.templates[name] = data.Body.toString('utf8');
      })
      .catch(function(err) {
        console.log("Failed to get template:", err);
      });
  };

  this.get_templates = function() {
    console.log("get_templates", this.templates_loaded);
    if (this.templates_loaded) {
      return Promise.resolve(this.templates);
    }

    if (this.get_templates_promise) {
      return this.get_templates_promise;
    }

    var promise = this.mys3.get_dir_listing('templates/').bind(this)
      .then(function(data) {
        // console.log("template_dir_listing", data);
        return Promise.all(
          data.Contents.map(function(file) {
            return this.get_template(file.Key);
          }, this));
      })
      .then(function() {
        this.templates_loaded = true;
        delete this.templates_promise;
        return this.templates;
      });

    this.get_templates_promise = promise;
    return promise;
  };

  this.render = function(template, state) {
    // Defer loading templates unless we need them.
    return this.get_templates()
      .then(function(templates) {
        return Mustache.render(templates[template], state, templates);
      });
  };
}

function path_to_filename(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function url_join() {
  var components = [];
  var n = arguments.length;
  for (var i = 0; i < n; i++) {
    var a = arguments[i].replace(/^\/+|\/+$/g, '');
    if (a.length > 0) {
      components.push(a);
    }
  }

  var url = components.join('/');
  if (arguments[0].startsWith('/')) {
    url = '/' + url;
  }

  return url;
}

function parse_config(mys3, key) {
  return mys3.get_file(key)
    .then(function(file) {
      return yaml.safeLoad(file.Body);
    });
}

function get_file_config(mys3, key) {
  console.log("get_file_config", key);
  return mys3.get_file(key)
    .then(function(file) {
      return matter(file.Body.toString('utf8'));
    });
}

function update_file_state(config, dir_state, dir_url, file) {
  var filename = path_to_filename(file.Key);

  // Check to see if this is the dir config file.
  if (filename === '_config.yaml') {
    console.log("Parsing ", file.Key);
    return parse_config(config.mys3, file.Key)
      .then(function(state) {
        extend(dir_state, state);
        return null;
      });
  }

  // Don't process config files.
  console.log("filename:", filename);
  if (filename.startsWith('_')) {
    return null;
  };

  var f_state = {
    filename: filename
  };

  dir_state.files.push(f_state);

  // Assume non-markdown files are raw files.
  if (!filename.endsWith('.markdown')) {
    f_state.raw = true;
    f_state.relative_url = filename;
    f_state.url = url_join(dir_url, filename);
    return null;
  }

  // This is a markdown file, we need to parse it.
  var base = filename.slice(0, filename.lastIndexOf('.'));
  f_state.relative_url = base + '.html';
  f_state.url= url_join(dir_url, base + '.html');

  return get_file_config(config.mys3, file.Key)
  .then(function(state) {
    extend(f_state, state.data);
    f_state.content = state.content;
    dir_state.posts.push(f_state);
    return null;
  });
}

function post_sort_cmp(a, b) {
  var a_order = ('order' in a) ? a.order : 0;
  var b_order = ('order' in b) ? b.order : 0;
  return a_order - b_order;
}

function update_subdir_state(config, prefix) {
  return config.mys3.get_dir_listing(prefix)
    .then(function(data) {
      console.log("In directory:", prefix);
      var relative_dir = prefix.slice(config.source_dir.length);
      var dir_url = url_join(config.base_url, relative_dir);
      var dir_state = {
        prefix: prefix,
        dirname: relative_dir.replace(/^\/+/, ''),
        url: dir_url,
        files: [],
        posts: [],
        subdirs: []
      };

      var work = [];

      // First process all files.
      work.push(Promise.map(data.Contents, function(file) {
        return update_file_state(config, dir_state, dir_url, file);
      }));

      // Then process all subdirectories.
      work.push(Promise.map(data.CommonPrefixes, function(s3_prefix) {
        var p = s3_prefix.Prefix;
        var directory = p.slice(p.lastIndexOf('/') + 1);
        return update_subdir_state(config, p)
        .then(function(state) {
          dir_state.subdirs.push(state);
        });
      }));

      return Promise.all(work)
        .then(function() {
          dir_state.posts.sort(post_sort_cmp);
          dir_state.default_post = dir_state.posts[0];
          dir_state.subdirs.sort(post_sort_cmp);
          return dir_state;
        });
    });
}

function gen_global_state(config) {
  return update_subdir_state(config, config.source_dir)
    .then(function(state) {
      state.base_url = config.base_url;
      return state;
    });
}

function render_file(config, global_state, filename, file_state) {
  console.log("Rendering file", filename);

  var input_filename = url_join(config.source_dir, filename);

  if (file_state.raw) {
    return config.mys3.copy_static(input_filename, filename);
  }

  // XXX Use same config options (misaka.*)
  var content_html = md.render(file_state.content);

  // Make the current page active.
  for (var i = 0; i < file_state.related_posts.length; i++) {
    var p = file_state.related_posts[i];
    if (p.url == file_state.url) {
      p.current = true;
    } else {
      p.current = false;
    }
  }

  var template = file_state.layout ? file_state.layout : 'post';
  var state = {content: content_html,
               site: global_state,
               page: file_state};

  return config.renderer.render(template, state)
    .then(function(html) {
      // console.log("rendered html", html);
      var base = filename.slice(0, filename.lastIndexOf('/') + 1);
      var out_filename = base + file_state.relative_url;
      return config.mys3.upload(out_filename, html);
    });
}

function render_subdir(config, global_state, path, directory_state) {
  console.log("Rendering dir:", path);

  // First process all files.
  var p_files = Promise.map(directory_state.files, function(file_state) {
    var filename = file_state.filename;
    var new_path = url_join(path, filename);
    // Don't include related posts on the top level pages.
    if (path !== '') {
      file_state.related_posts = directory_state.posts;
    } else {
      file_state.related_posts = [];
    }

    return render_file(config, global_state, new_path, file_state);
  });

  // Now process all subdirectories.
  var p_dirs = Promise.map(directory_state.subdirs, function(dir_state) {
    var dirname = dir_state.dirname;
    var new_path = url_join(path, dirname);
    return render_subdir(config, global_state, new_path, dir_state);
  });

  return Promise.join(p_files, p_dirs);
}

function render(config, global_state) {
  return render_subdir(config, global_state, '', global_state);
}

exports.handler = function(event, context) {
  if (typeof event.bucket === 'undefined') {
    context.fail('No bucket defined.');
  }

  if (typeof event.type === 'undefined') {
    context.fail('No type defined.');
  }

  var mys3 = new MyS3(event.bucket, event.type);
  var renderer = new Renderer(mys3);

  var config = {
    source_dir: 'src',
    base_url: '/',
    mys3: mys3,
    renderer: renderer
  };

  mys3.get_config()
    .then(function() {
      return gen_global_state(config);
    })
    .then(function(state) {
      return render(config, state);
    })
    .then(function() {
      context.succeed();
    })
    .catch(function(e) {
      context.fail(e);
    });
};
