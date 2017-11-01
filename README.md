# ftpp

### aka FTPPush

A command line utility with one purpose; to watch a directory of files and push changes to a ftp server.

* It does not sync.
* It does not download.
* It only uploads & deletes files from an FTP server.

## Usage 
`npm i -g ftpp`
 * Create a `yourProject.ftpp` file.
 * Run: `ftpp`
 * Or if you have multiple *.ftpp files
    * `ftpp -t test`
    * where test == test.ftpp

## *.ftpp files
This is just an ini file, using the excellent [ini](https://www.npmjs.com/package/ini) library.

The default.ftpp file. Just copy this to your project folder and edit as required.

```ini
; Un comment lines as required to overwrite defaults.

; ftp connection details. Passed through to `ftp.connect()`
; @see https://www.npmjs.com/package/ftp#methods for details
[ftp]
; host = your.ftp.host
; user = your-username
; password = some_super_secure_password

; ftpp connection settings
[connectionSettings]
parallel = 10
connectionRetry = 3

[paths]
; remote = /path/to/your/remote/directory/
; base = cwd();
; file, dir, glob, or array. Passed through to `chokidar.watch()`
; source = ./string/path/to/your/local/files/
; source[] = or/use/an/array/values/

; values passed through to the `chokidar.watch()` options value
; @see https://www.npmjs.com/package/chokidar#api for details
[watchOptions]
ignoreInitial = true
ignored[] = ./node_modules/**/*
ignored[] = ./.git/**/*
```

## Why?
Its targeted towards local development. So you don't have to manually upload changes, or use a ftp client to "sync" changes. Sure some ftp clients can handle this, but using configuration files and a global command makes working with a remote (or local) dev server a breeze.
