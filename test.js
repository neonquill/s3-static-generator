// node ./test.js s3-bucket-name test

var lib = require('./index.js');

var context = {
  succeed: function() {
    console.log("XXX DONE!");
  },

  fail: function(e) {
    console.log("XXX FAIL", e);
  }
};

var event = {
  bucket: process.argv[2],
  type: process.argv[3]
};

lib.handler(event, context);
