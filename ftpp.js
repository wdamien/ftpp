#! /usr/bin/env node

var async = require('async');
var chokidar = require('chokidar');
var colors = require('colors');
var fs = require('fs');
var ftp = require('ftp');
var globby = require('globby');
var ini = require('ini');
var _ = require('lodash');
var path = require('path');
var process = require('process');
var program = require('commander');
var inquirer = require('inquirer');

class Ftpp {

    static get UPLOAD () {  return 1; }
    static get DELETE () {  return 2; }

    constructor() {
        this.complete = false;
        this.config = null;
        this.watcher = null;
        this.ftpActions = [];
        this.connected = false;
        this.connectionRetryCount = 0;
        this.cwd = process.cwd();

        process.on('unhandledRejection', function(reason, p) {
            console.log('Possibly Unhandled Rejection at: Promise ', p, 'reason: ', reason);
        });
        
        this.createFtpConnection();
    }

    createFtpConnection() {
        this.ftpConn = new ftp();

        this.ftpConn.on('ready', evt => {
            this.logFTP('connected');
            this.connected = true;
            this.processQueue();
        });
        
        this.ftpConn.on('greeting', msg => {
            this.logFTP(`greeting ${msg}`);
        });
        
        this.ftpConn.on('close', err => {
            this.connected = false;
            this.logFTP('close', false);
            if (++this.connectionRetryCount < this.config.connectionSettings.connectionRetry) {
                this.connect();
            } else {
                this.ftpConn.destroy();
                this.complete = true;
            }
        });
        
        this.ftpConn.on('end', err => {
            this.logFTP('end');
        });
        
        this.ftpConn.on('error', err => {
            this.logFTP(err.message, false);
        });
    }

    logFTP(message, success) {
        if (success !== false) {
            this.logSuccess('FTP', message);
        } else {
            this.logError('FTP', message);
        }
    }

    logError(prefix, message) {
        if (prefix != null && prefix.hasOwnProperty("message")) {
            prefix = prefix.message;
        }

        if (message != null) {
            message = ((prefix + ': ').bold.red) + (''.reset) + (message.red);
        } else {
            message = prefix.red;
        }
        console.log(message);
    }

    logSuccess(prefix, message) {
        if (message != null) {
            message = ((prefix + ': ').bold.green) + (''.reset) + (message.green);
        } else {
            message = prefix.green;
        }
        console.log(message);
    }
    
    logStatus(prefix, message) {
        if (message != null) {
            message = ((prefix + ': ').bold.yellow) + (''.reset) + (message.yellow);
        } else {
            message = prefix.yellow;
        }
        console.log(message);
    }
    
    logMessage(message) {
        console.log(message);
    }

    wait() {
        if (!this.complete) { setTimeout(this.wait.bind(this), 500); }
    }

    getDefaultConfigFile() {
        return this.readFile(path.join(__dirname, 'defaults.ftpp'));
    }

    readFile(path) {
        return fs.readFileSync(path, 'utf-8');
    }

    readFileAsJson(path) {
        return JSON.parse(this.readFile(path));
    }

    getVersion() {
        var pkg = this.readFileAsJson(path.join(__dirname, 'package.json'));
        return (' ftpp v' + pkg.version + ' ').bgBlue;
    }
    
    run() {        
        this.logMessage(this.getVersion());

        // For local testing we filter out the defaults file.
        globby([path.join(this.cwd, '/*.ftpp'), '!' + path.join(__dirname, 'defaults.ftpp')]).then(paths => {
            if (paths.length == 0) {
                this.logError('No config file found!', 'Run `ftpp init` to create one.');
                this.complete = true;
                return null;
            }

            var configFilePath = program.config;

            if (configFilePath == null && paths.length > 1) {
                paths.forEach((item, idx, arr) => {
                    arr[idx] = path.basename(item);
                });
                
                inquirer.prompt([
                    {
                        name:'config',
                        message:'Multiple config files found! Which one would you like to use?',
                        type: 'list',
                        choices: paths
                    },
                ]).then((answer) => {
                   this.runWithConfigFile(path.join(this.cwd, answer.config));
                });
            } else if (configFilePath == null && paths.length == 1) {
                this.runWithConfigFile(paths[0]);
            } else {
                configFilePath = path.basename(configFilePath, '.ftpp');
                var configFile = null;

                for (var i = 0; i < paths.length; i++) {
                    var file = paths[i];
                    if (path.basename(file, '.ftpp') == configFilePath) {
                        configFile = file;
                        break;
                    }
                }

                this.runWithConfigFile(configFile);
            }
        }).catch(err => {
            this.logError(err);
        });
        
        this.wait();
    }

    runWithConfigFile(configFile) {
        this.logStatus('Using config file', path.basename(configFile));
        
        this.config = ini.decode(this.readFile(configFile));
        this.config = _.defaultsDeep(this.config, ini.parse(this.getDefaultConfigFile()));
        var required = [
            "ftp.host",
            "ftp.user",
            "ftp.password"
        ];

        var missing = [];
        required.forEach(key => {
            if (!_.has(this.config, key)) {
                missing.push(key);
            }
        });
        
        if (missing.length > 0) {
            this.logError("Required config values missing!", "'"+missing.join("', '") + "'");
            return;
        }

        if (this.config.paths.base == null) {
            this.config.paths.base = this.cwd;
        } else {
            this.config.paths.base = path.resolve(this.config.paths.base);
        }

        this.logStatus('Using base path', this.config.paths.base);

        this.connect();

        var watchSource = this.config.paths.source;
        if (!Array.isArray(watchSource)) {
            watchSource = path.resolve(watchSource);
        }
        
        if (this.config.watchOptions && this.config.watchOptions.ignored) {
            this.config.watchOptions.ignored.forEach(function(item, idx, arr) {
                arr[idx] = path.resolve(item);
            });
        }

        var watcher = chokidar.watch(watchSource, this.config.watchOptions);
        watcher
        .on('add', this.handleFileAdd.bind(this))
        .on('change', this.handleFileChange.bind(this))
        .on('unlink', this.handleFileDelete.bind(this))
        .on('unlinkDir', this.handleDirectoryDelete.bind(this))
        .on('error', error => this.logError('Watcher error', error));
    }
    
    processFileChanges() {
        clearTimeout(this.processFileChangesInt);
        this.processFileChangesInt = setTimeout(() => {
            //Check for deleted directories, and remove any children from the actions list.
            var directoryDeletes = [];
            this.ftpActions.forEach((action) => {
                if (action.type == Ftpp.DELETE && action.isDirectory) {
                    directoryDeletes.push(action);
                }
            });

            var actionsToRemove = [];
            directoryDeletes.forEach((directory) => {
                this.ftpActions.forEach((action) => {
                    if (action.type == Ftpp.DELETE && !action.isDirectory) {
                        if (path.dirname(action.file) == this.truncateLocalPath(directory.file)) {
                           actionsToRemove.push(action);
                        }
                    }
                });
            });
            
            actionsToRemove.forEach((action) => {
                this.ftpActions.splice(this.indexOfAction(action), 1);
            });

            // Send to FTP!
            this.processQueue();
        }, 250);
    }

    handleFileAdd(path, stat) {
        this.addAction(new FtpAction(Ftpp.UPLOAD, path));
    }
    
    handleFileChange(path, stat) {
        this.addAction(new FtpAction(Ftpp.UPLOAD, path));
    }
    
    handleFileDelete(path) {
        this.addAction(new FtpAction(Ftpp.DELETE, path));
    }
    
    handleDirectoryDelete(path) {
        var action = new FtpAction(Ftpp.DELETE, path);
        action.isDirectory = true;
        this.addAction(action);
    }

    addAction(action) {
         // Filter dups.
         if (this.indexOfAction(action) == -1) {
            this.ftpActions.push(action);
            this.processFileChanges();
         }
    }

    indexOfAction(action) {
        for (var i = 0; i < this.ftpActions.length; i++) {
            if (this.ftpActions[i].equals(action)) {
               return i;
            }
        }
        return -1;
    }

    connect() {
        this.logStatus('FTP attempting to connect...', `(${this.connectionRetryCount+1} of ${this.config.connectionSettings.connectionRetry})`);
        this.ftpConn.connect(this.config.ftp);
    }

    processQueue() {
        if (this.connected == true && this.ftpActions.length > 0 && !this.isProcessing) {
            var _this = this;
            this.isProcessing = true;
            var actions = this.ftpActions.slice(0);
            this.ftpActions = [];

            async.eachLimit(actions, this.config.connectionSettings.parallel, function (action, cb) {
                var file = path.resolve(action.file);
                var remoteFile = path.join(_this.config.paths.remote, _this.truncateLocalPath(file));
                
                var remoteFolder = null;

                if (action.isDirectory == false) {
                    remoteFolder = path.dirname(remoteFile);
                } else {
                    remoteFolder = remoteFile;
                }

                remoteFolder = remoteFolder.split('\\').join('/');

                // Ensure the folder is created and navigated to.
                _this.createAndChangeDirectory(remoteFolder).then(() => {
                    var promise = null;
                    if (action.type == Ftpp.DELETE) {
                        _this.logSuccess('Deleting', _this.truncateLocalPath(file));
                        promise = _this.delete(file, action.isDirectory);
                    } else if (action.type == Ftpp.UPLOAD) {
                        _this.logSuccess('Uploading', _this.truncateLocalPath(file));
                        promise = _this.put(file);
                    }
                    promise.then(() => {
                        cb();
                    }).catch(err => {
                        if (err) {
                            _this.logError(err);
                        }
                        cb();
                    });
                }).catch((err) =>{
                    _this.logError(err);
                    cb();
                });
            }, err => {
                if (err != null) {
                    this.logError(err);
                } else {
                    this.isProcessing = false;
                    this.processQueue();
                }
            })
        }
    }

    put(file) {
        var _this = this;
        return new Promise(function(resolve, reject) {
            _this.ftpConn.put(file, path.basename(file), function (err) {
                if (err == null) {
                    _this.logSuccess('Upload complete', _this.truncateLocalPath(file) + '\n');
                    resolve();
                } else {
                    reject(err);
                }
            });
        });
    }

    delete(file, isDirectory) {
        var _this = this;
        return new Promise(function (resolve, reject) {
            if (isDirectory !== true) {
                _this.ftpConn.delete(path.basename(file), function (err) {
                    if (err == null) {
                        _this.logSuccess('Delete complete', _this.truncateLocalPath(file));
                        resolve();
                    } else {
                        reject(err);
                    }
                });
            } else {
                _this.ftpConn.cdup(err => {
                    if (err == null) {
                        _this.ftpConn.rmdir(path.basename(file), true, function (err) {
                            if (err == null) {
                                _this.logSuccess('Delete complete', _this.truncateLocalPath(file));
                                resolve();
                            } else {
                                reject(err);
                            }
                        });
                    } else {
                        reject(err);
                    }
                });
            }
        });
    }

    createAndChangeDirectory(dir) {
        var _this = this;
        return new Promise(function (resolve, reject) {
            _this.ftpConn.cwd(dir, function (err) {
                if (err == null) {
                    resolve();
                } else {
                    _this.ftpConn.mkdir(dir, true, function(err) {
                        if (err == null) {
                            _this.ftpConn.cwd(dir, function (err) {
                                if (err == null) {
                                    resolve();
                                } else {
                                    reject(err);
                                }
                            });
                        } else {
                            reject(err);
                        }
                    });
                }
            });
        });
    }

    truncateLocalPath(file) {
        return file.slice(this.config.paths.base.length+1);
    }

    initializeFolder() {
        inquirer.prompt([
            {name:'username', message:'FTP Username'},
            {name:'password', message:'FTP Password'},
            {name:'host', message:'FTP Host'},
            {name:'remote', message:'Remote Directory'},
            {name:'fileName', message:'Config file name?', default: path.basename(this.cwd)}
        ]).then((answers) => {
            var config = ini.decode(this.getDefaultConfigFile());
            config.ftp = {
                user: answers.username,
                password: answers.password,
                host: answers.host
            };

            config.paths = {
                remote: answers.remote
            };

            var configString = ini.encode(config);
            var fileName = path.basename(answers.fileName, '.ftpp') + '.ftpp';
            fs.writeFileSync(path.join(this.cwd, fileName), configString);
            this.logSuccess('Success! Run', `ftpp ${path.basename(fileName, '.ftpp')}`);
        });
    }
}

class FtpAction {
    constructor(type, file) {
        this._type = type;
        this._file = file;
        this._isDirectory = false;
    }

    get type() { return this._type; }

    get file() { return this._file; }
    set file(value) { this._file = value; }

    get isDirectory() { return this._isDirectory; }
    set isDirectory(value) { this._isDirectory = value; }

    equals (other) {
        if (other != null) {
            return this.type === other.type && this.file == other.file;
        } else {
            return false;
        }
    }
}

var ftpp = new Ftpp();

program
.version(ftpp.getVersion())
.option('-c, --config [config]', 'Which config file do you want to use?')
.option('-v, --version', 'Latest installed version.')
.option('init', 'Initialize a new ftpp file.')
.parse(process.argv);

if (program.init) {
    ftpp.initializeFolder();
} else {
    ftpp.run();
}
