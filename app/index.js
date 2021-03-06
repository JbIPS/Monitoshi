// imports
var express    = require('express');
var app = module.exports = express();
var bodyParser = require('body-parser');

// config
var config;
if (process.env.MT_CONFIG) {
    config = JSON.parse(process.env.MT_CONFIG);
}
else {
    var fs = require('fs');
    var configFile = process.env.MT_CONFIG_FILE || __dirname + '/../default-config.js';
    config = require(configFile);
    console.log('MT_CONFIG env variable is not defined, and MT_CONFIG_FILE is set to',
        process.env.MT_CONFIG_FILE,
        'The config will be read from', configFile);
}
function displayResult(req, res, data) {
  if(req.query.format === 'json') {
    if(data.success === true) res.status(200);
    else res.status(500);
    res.json(data);
  }
  else {
    if(data.success === true) {
      var footer = '<hr>Thank you for using <a href="https://github.com/lexoyo/Monitoshi/" target="_blank">Monitoshi</a>';
      if(data.message) {
        res.status(200).send('<h1>' + data.message + '</h1>' + footer);
      }
      else {
        res.status(200).send('<h1>List of monitors</h1>' + formatList(data.items) + footer);
      }

    }
    else {
      res.status(500).send('<h1>' + (data.message || '') + '</h1><hr>Something went wrong, we are sorry about that. Here is <a href="https://github.com/lexoyo/Monitoshi/issues" target="_blank">the help section of Monitoshi</a>.');
    }
  }
}
function formatList (items) {
  return '<ul>' + items.map(function(item) {
    return '<li><ul>' +
      '<li><a href="' + item.url + '">' + item.url + '</a>' +
      ' (' + (item.__enabled ? 'confirmed' : 'NOT confirmed') + ', ' + (item.state || 'Unknown') + ')</li>' +
      '<li><a href="/monitor/' + item._id + '/enable">enable</a></li>' +
      '<li><a href="/monitor/' + item._id + '/disable">disable</a></li>' +
      '<li><a href="/monitor/' + item._id + '/del">del</a></li>' +
      '</ul></li>';
  })
  .join('') + '</ul>';
}
console.info('***********************************');
console.info('Monitoshi starting');
console.info('***********************************');

var WebHookAlert = require('./alert/web-hook');
var PingMonitor = require('./monitor/ping');
var monitor = new PingMonitor(config.timeout, config.interval, config.attempts);

// loop on data
var DataManager = require('./queue/data-manager');
var dataManager = new DataManager('inst1', nextLoop);
var currentData = null;


function nextLoop() {
    dataManager.unlockAll(function(err, result) {
        dataManager.lockNext(function(err, result) {
            if(result) {
                currentData = result;
                monitor.poll(currentData.url);
            }
            else {
                // no data in the DB
                setTimeout(nextLoop, 100);
            }
        });
    });
}
monitor
.on('success', function(statusCode) {
    if(currentData.state === 'down') {
        console.info('** Monitor',  currentData, 'is now up', statusCode);
        sendUpEmail(currentData);
    }
    dataManager.unlock(currentData, {state: 'up'}, function(err, result) {
        nextLoop();
    });
})
.on('error', function(err) {
    if(currentData.state === 'up') {
        console.info('** Monitor',  currentData, 'is now down -', err);
        sendDownEmail(currentData);
        dataManager.store('stats',  {
          $setOnInsert: {
            created: Date.now()
          },
          $inc: {
            downtimesCount: 1
          }
        }, function(err, result) {});
    }
    dataManager.unlock(currentData, {state: 'down'}, function(err, result) {
        nextLoop();
    });
});

// API
app.use(bodyParser.json()); // for parsing application/json
app.use(bodyParser.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded
if(process.env.MONITOSHI_ADMIN_PASS) {
  app.get('/' + process.env.MONITOSHI_ADMIN_PASS + '/', function(req, res) {
    dataManager.list(function(err, dataArr) {
      if(err) {
        displayResult(req, res, {"success": false, "message": err.message });
      }
      else {
        displayResult(req, res, {"success": true, "items": dataArr});
      }
    });
  });
}
app.post('/monitor', function(req, res) {
    var data = {
      email: req.body.email,
      url: req.body.url,
      serverUrl: req.protocol + '://' + req.get('host')
    };
    console.info('Route:: add monitor', typeof data, data);
    dataManager.add(data, function(err, data) {
      if(err) {
          displayResult(req, res, {"success": false, "message": err.message });
      }
      else {
          if(data) {
              sendConfirmationEmail(req.protocol + '://' + req.get('host'), data._id, data.email, data.url);
              displayResult(req, res, {"success": true, "message": "The monitor is created, please check your emails and activate it."});
          }
          else {
              displayResult(req, res, {"success": false, "message": "Monitor not found." });
          }
      }
    });
});

app.get('/info', function(req, res) {
    dataManager.count(function(err, count) {
        dataManager.get('stats', function(err, stats) {
            if(!stats) stats = {};
            res.render('info.ejs', {
                "downtimes": stats.downtimesCount,
                "created": new Date(stats.created),
                "monitors": count
            });
        });
    });
});

app.get('/monitor/:id/enable', function(req, res) {
    console.log('Route:: enable monitor', req.params.id);
    dataManager.enable(req.params.id, function(err, data) {
      if(err) {
          displayResult(req, res, {"success": false, "message": err.message });
      }
      else {
          if(data) {
            sendStartEmail(req.protocol + '://' + req.get('host'), data._id, data.email, data.url);
            displayResult(req, res, {"success": true, "message": "The monitor is now active."});
          }
          else {
              displayResult(req, res, {"success": false, "message": "Monitor not found." });
          }
      }
    });
});
app.get('/monitor/:id/disable', function(req, res) {
    console.log('Route:: enable monitor', req.params.id);
    dataManager.disable(req.params.id, function(err) {
      if(err) {
        displayResult(req, res, {"success": false, "message": err.message });
      }
      else {
        displayResult(req, res, {"success": true, "message": "The monitor has been disabled."});
      }
    });
});
app.get('/monitor/:id/del', function(req, res) {
    console.log('Route:: del monitor', req.params.id);
    dataManager.del(req.params.id, function(err, data) {
      if(err) {
        displayResult(req, res, {"success": false, "message": err.message });
      }
      else {
        if(data) {
            sendStopEmail(req.protocol + '://' + req.get('host'), data._id, data.email, data.url);
            displayResult(req, res, {"success": true, "message": "The monitor has been deleted."});
        }
        else {
            displayResult(req, res, {"success": false, "message": "Monitor not found." });
        }
      }
    });
});

// public folder
app.use('/', express.static(__dirname + '/../public'));
// template engine
app.set('view engine', 'ejs');
app.set('views', 'app/views');

// listen to http requests
if (!module.parent) {
  var port = process.env.PORT || 7070;
  app.listen(port, function() {
    console.log('Listening on ' + port);
  });
}
else {
    console.log('do not listen to any port since there is a parent app');
}

// confirmation emails
var nodemailer = require('nodemailer');
var transporter = nodemailer.createTransport(config.nodemailer);
function sendConfirmationEmail(serverUrl, id, email, url) {
    var callbackUrl = serverUrl + '/monitor/' + id + '/enable';
    console.log('sendConfirmationEmail', callbackUrl, email, url);
    transporter.sendMail({
        from: config.nodemailer.auth.user,
        to: email,
        subject: 'Please confirm monitor creation',
        text: 'Please follow this link to confirm that you wish Monitoshi to warn you by email when ' + url + ' is down.\n' + callbackUrl
    });
}
function sendStartEmail(serverUrl, id, email, url) {
    var callbackUrl = serverUrl + '/monitor/' + id + '/del';
    console.log('sendStartEmail', callbackUrl, email, url);
    transporter.sendMail({
        from: config.nodemailer.auth.user,
        to: email,
        subject: 'Monitor Created',
        text: 'This is an email to confirm that Monitoshi will warn you by email when ' + url + ' is down.\nIf you want TO DELETE it one day, and prevent Monitoshi to watch for this website, follow this link: ' + callbackUrl
    });
}
function sendStopEmail(serverUrl, id, email, url) {
    console.log('sendStopEmail', email, url);
    transporter.sendMail({
        from: config.nodemailer.auth.user,
        to: email,
        subject: 'Monitor Deleted',
        text: 'This is an email to confirm the deletion of a monitor. Monitoshi will not warn you anymore when ' + url + ' is down.'
    });
}
function sendDownEmail(data) {
    var callbackUrl = data.serverUrl + '/monitor/' + data._id + '/del';
    console.log('sendDownEmail', data.email, data.url);
    transporter.sendMail({
        from: config.nodemailer.auth.user,
        to: data.email,
        subject: '[Alert]Your website is DOWN',
        text: 'This is an email to warn you that ' + data.url + ' is down.\nIf you want me to stop monitoring this website, follow this link: ' + callbackUrl
    });
}
function sendUpEmail(data) {
    var callbackUrl = data.serverUrl + '/monitor/' + data._id + '/del';
    console.log('sendUpEmail', data.email, data.url);
    transporter.sendMail({
        from: config.nodemailer.auth.user,
        to: data.email,
        subject: '[Alert]Your website is UP',
        text: 'This is an email to inform you that ' + data.url + ' is up again.\nIf you want me to stop monitoring this website, follow this link: ' + callbackUrl
    });
}
