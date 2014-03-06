var fs = require('fs'),
exif = require('./exif.js'),
walk = require('walk'),
util = require('util'),
path = require('path'),
gm = require('gm');

var gallery = {
  /*
   * Directory where the photos are contained
   */
  directory : undefined,

  /*
   * Optional static directory to prefix our directory references with
   * This won't get output in templates - only needed if we've defined a static
   * directory in a framework like express.
   */
  static: undefined,


  /*
   * root URL of the gallery - defaults to root, or '' - NOT '/'
   * an example would be '/gallery', NOT '/gallery/'
   * This has no reflection on where the static assets are stored
   * it's just where our gallery lies in a URL router
   */
  rootURL: '',

  /*
   * Our constructed album JSON lives here
   */
  album: undefined,
  /*
   * Name of our gallery
   */
  name: 'Photo Gallery',

  /*
   * Image to display when no thumbnail could be located
   */
  noThumbnail: '', // TODO: Bundle a default no thumbnail image?
  /*
   * Filter string to use for excluding filenames. Defaults to a regular expression that excludes dotfiles.
   */
  filter: /^Thumbs.db|^\.[a-zA-Z0-9]+/,

  /*
   * Object used to store binary chunks that represent image thumbs
   */
  imageCache: {},
  /*
   * Private function to walk a directory and return an array of files
   */
  readFiles: function(params, cb){
    var files = []
    , directoryPath = (this.static) ? this.static + "/" + this.directory : this.directory
    , links = []
    , me = this
    , obtype
    , objects = [];

    try{
      obtype = fs.readlinkSync(directoryPath + "/^");
    }catch(e){
      return cb('no object type symlink ^')
    }
    if ( obtype != 'Photo-Gallery' )
      return cb("obtype ^ is not 'Photo-Gallery'")

    // use album.json if found instead of walking files and directories:
    try{
      return cb(null, JSON.parse(fs.readFileSync(directoryPath + "/album.json")));
    }catch(e){
      // there was no album.json, so continue processing
    }

    var walker  = walk.walk(directoryPath, { followLinks: false });

 // walker.on("symbolicLink", function (root, symlinksStat, next) {
 //   console.log('SYMLINK: ' + root + ':');
 //   console.log(symlinksStat.name);
 //   console.log(symlinksStat);
 //   next();
 // });

    walker.on("directories", function (root, dirStatsArray, next) {
      // dirStatsArray is an array of `stat` objects with the additional attributes
      // * type
      // * error
      // * name
   // console.log(dirStatsArray);
      next();
    });

    // each Photo-Gallery Photo object containing: _.jpg t.jpg m.jpg ^, where:
    //   _.jpg -> original jpeg
    //   t.jpg -> thumbnail
    //   m.jpg -> medium
    //   ^ -> Photo, the thinobject type

    walker.on('file', function(root, stat, next) {
      var dirs = root.replace(directoryPath + "/", "").split("/"),
        ob;

      if (stat.name.match(/^_\.jpg$/i)){
        ob = {
          type: 'Photo',
          name: dirs.pop(),
          dir: dirs.join('/')
        };
        objects.push(ob);
        return next();
      }

      if (stat.name.match(/^_\.(avi|mov)$/i)){
        ob = {
          type: 'Movie',
          name: dirs.pop(),
          dir: dirs.join('/')
        };
        objects.push(ob);
        return next();
      }

      if (stat.name.match(/^.\.jpg$/i)){
        // ignore other one-character jpeg files
        return next();
      }

      if (!stat.name.match(/\.jpg$/i)){
        // ignore any non-jpeg files
        return next();
      }

      // finally, store list of remaining jpeg files with longer names:

      ob = {
        type: 'Jpeg',
        name: stat.name,
        dir: dirs.join('/')
      };
      objects.push(ob);
      return next();
    });

    walker.on('end', function() {
      return cb(null, objects);
    });
  },
  /*
   * Private function to build an albums object from the objects[] array
   */
  buildAlbums: function(objects, cb){
    var dirHash = {}, albums = {
      name: this.name,
      prettyName: this.name,
      isRoot: true,
      path: this.directory,
      photos: [],
      jpegs: [],
      albums: []
    };
 // console.log(objects);
    for (var i=0; i<objects.length; i++){
      // Process a single file
      var ob = objects[i]
      , dirs = ob.dir.split("/")
      , dirHashKey = ""
      , curAlbum = albums; // reset current album to root at each new file

      // Iterate over the directory path, checking if we've got an album for each
      // ""!==dirs[0] as we don't want to iterate if we have a file that is a photo at root
      for (var j=0; j<dirs.length; j++){
        var curDir = dirs[j];
        dirHashKey += curDir;

        if (!dirHash.hasOwnProperty(dirHashKey)){
          // If we've never seen this album before, let's create it
          // first reconstruct the current path with the path slashes
          var currentAlbumPath = dirs.slice(0, j+1).join('/');
          dirHash[dirHashKey] = true;
          // TODO - consider binding the album to this hash, and even REDIS-ing..

          var newAlbum = {
            name: curDir,
            prettyName: decodeURIComponent(curDir),
            description: "",
            hash: dirHashKey,
            path: currentAlbumPath,
            photos: [],
            jpegs: [],
            albums: []
          };

          curAlbum.albums.push(newAlbum);
          curAlbum = newAlbum;
        }else{
          // we've seen this album, we need to drill into it
          // search for the right album & update curAlbum
          var curAls = curAlbum.albums;
          for (var k=0; k<curAls.length; k++){
            var al = curAls[k];
            if (al.hash === dirHashKey){
              curAlbum = al;
              break;
            }
          }
        }
      }
      var obpath = ob.dir + '/' + ob.name

      if(ob.type == "Symlink") {
        if ( ob.name = 'description' ) curAlbum.description = ob.value.replace(/^=/,'');
        if ( ob.name = 'prettyname' ) curAlbum.prettyName = ob.value.replace(/^=/,'');
        if ( ob.name = 'thumbnail' ) curAlbum.thumb = ob.value;
      }
      else if(ob.type == "Jpeg") {
        // the Jpeg object is an image file, should be duplicated in a Photo object
        // each Photo object was generated from a Jpeg file, hardlinked as _.jpg
        var jpeg = {
          name: ob.name,
          path: obpath
        };
     // console.log('JPEG: ' + jpeg.name + ' @ ' +jpeg.path);
        curAlbum.jpegs.push(jpeg);
      
      }
      else if(ob.type == "Photo") {
        var photo = {
          name: ob.name,
          path: obpath
        };
        // the Photo object is a directory with _.jpg, t.jpg, ...
  
        //curAlbum.photos.push(photo);
  
        // we have a photo object - let's try get its exif data. We've
        // already pushed into curAlbum, no rush getting exif now!
        // Create a closure to give us scope to photo
        (function(photo, curAlbum){
          var fullPath = gallery.directory + "/" + photo.path + '/_.jpg';
          fullPath = (gallery.static) ? gallery.static + "/" + fullPath: fullPath;
  
          exif(fullPath, photo, function(err, exifPhoto){
            // no need to do anything with our result - we've altered
            // the photo object..
          });
        })(photo, curAlbum);
        curAlbum.photos.push(photo);
      }
    }

    // fn to iterate over our completed albums, calling _buildThumbnails on each
    function _recurseOverAlbums(al){

      if (!al.thumb){
        al.thumb = _buildThumbnails(al);
      }

      if (al.albums.length>0){
        for (var i=0; i<al.albums.length; i++){
          _recurseOverAlbums(al.albums[i]);
        }
      }
      if (al.jpegs.length>0){
        console.log(al.jpegs.length + ' JPEGS, '
                  + al.photos.length + ' PHOTOS in ALBUM ' + al.name );
        for (var i=0; i<al.jpegs.length; i++){
          var ob = al.jpegs[i].name.replace(/\.jpg/i, '');
       // console.log('   ' + al.jpegs[i].name);
          for (var j=0; j<al.photos.length; j++){
            if ( al.photos[j].name === ob ) break;
          }
          if ( j<al.photos.length ) continue;
          jpeg = [me.static, me.directory, al.jpegs[i].path].join('/');
          ob = [me.static, me.directory, al.jpegs[i].path.replace(/\.jpg/i, '')].join('/');
          console.log('  CREATE OBJECT ' + ob);
          try{
            fs.mkdirSync(ob);
           }catch(e){
             console.log(e);
           }
          fs.linkSync(jpeg,ob + '/_.jpg');
        }
      }
    }

    var me = this;

    function _buildThumbnails(album){
      var photoChildren = album.photos,
      albumChildren = album.albums;

      if (photoChildren.length && photoChildren.length>0){
        var albumThumb = photoChildren[0].path;
        return albumThumb;
      }else{
        if (albumChildren.length && albumChildren.length>1){
          return _buildThumbnails(albumChildren[0]);
        }else{
          // TODO: No image could be found
          return me.noThumbnail;
        }
      }
    }

    _recurseOverAlbums(albums);

    return cb(null, albums);
  },
  /*
   * Public API to node-gallery, currently just returns JSON block
   */
  init: function(params, cb){
    var me =  this,
      dir = params.directory.replace(/^\/+/,"").replace(/\/+$/,""),
      sdir =   params.static.replace(/^\/+/,"").replace(/\/+$/,"");

    if (!cb || typeof cb !=="function"){
      cb = function(err){
        if (err) {
          throw new Error(err.toString());
        }
      };
    }

    if (!dir) throw new Error('`directory` is a required parameter');

    this.rootURL = params.rootURL;
    this.directory = params.directory.replace(/^\/+/,"").replace(/\/+$/,""),
    this.static       = params.static.replace(/^\/+/,"").replace(/\/+$/,"");
    this.name = params.name || this.name;

    this.filter = params.filter || this.filter;

    this.readFiles(null, function(err, objects){
      if (err){
        return cb(err);
      }
   // console.log("OBJECTS:"); console.log(objects);

      me.buildAlbums(objects, function(err, album){
        me.album = album;
        console.log("ALBUM"); console.log(album);
        return cb(err, album);
      })
 // console.log('quitting for debug'); process.exit(2);
    });
  },
  /*
   * Returns a photo. Usage:
   * getPhoto({ photo: 'test.jpg', album: 'Ireland'}, function(err, photo){
   *   console.log(photo.path);
   * );
   */
  getPhoto: function(params, cb){
    // bind the album name to the request
    var photoName = params.photo.replace(/\/.\.[^\.]+$/, "")
    , albumPath = params.album;
    this.getAlbum(params, function(err, data){
      if (err){
        return cb(err);
      }
      var album = data.album;
      var photos = album.photos;
      for (var i=0; i<photos.length; i++){
        var photo = photos[i];
        if (photo.name===photoName){

          return gallery.afterGettingItem(null, {type: 'photo', photo: photo}, cb);
        }
      }

      return cb('Failed to load photo ' + photoName + ' in album ' + albumPath, null);
    });
  },
  /*
   * Function to return a specific album. Usage:
   * gallery.getAlbum({ album: 'Ireland/Waterford', function(err, album){
   *   console.log(album.path);
   * });
   */
  getAlbum: function(params, cb){
    var album = this.album,
    albumPath = params.album;

    if (!albumPath || albumPath==''){
      //return cb(null, album);
      return this.afterGettingItem(null, {type: 'album', album: album}, cb);
    }

    var dirs = albumPath.split('/');

    for (var i=0; i<dirs.length; i++){
      var dir = dirs[i];
      var aChildren = album.albums;
      for (var j=0; j<aChildren.length; j++){
        var aChild = aChildren[j];
        if (aChild.name === dir){
          album = aChild;
        }
      }
    }
    if (album.hash !== albumPath.replace(/\//g, "")){
      return cb('Failed to load album ' + albumPath, null);
    }
    return this.afterGettingItem(null, {type: 'album', album: album}, cb);

  },
  /*
   * Private function which massages the return type into something useful to a website.
   * Builds stuff like a breadcrumb, back URL..
   */
  afterGettingItem: function(err, data, cb){
    var item = data[data.type];
    var breadcrumb = item.path.split("/");
    var back = data.back = breadcrumb.slice(0, item.path.split("/").length-1).join("/"); // figure out up a level's URL

    // Construct the breadcrumb better.
    data.breadcrumb = [];
    var breadSoFar = "" + this.rootURL + "";
    // Add a root level to the breadcrumb
    data.breadcrumb.push({name: this.name, url: this.rootURL});
    for (var i=0; i<breadcrumb.length; i++){
      var b = breadcrumb[i];
      if (b==""){
        continue;
      }
      breadSoFar += "/" + breadcrumb[i];

      data.breadcrumb.push({
        name: b,
        url: breadSoFar
      });
    }

    data.name = this.name;
    data.directory= this.directory;
    data.dir = this.rootURL;

    return cb(err, data);
  },
  middleware: function(options){
    var me = this;
    this.init(options);

    return function(req, res, next){
      var url = req.url,
      rootURL = gallery.rootURL,
      params = req.params,
      requestParams = {},
      image = false;

      var staticTest = /\.png|\.jpg|\.css|\.js/i;
      if (rootURL=="" || url.indexOf(rootURL)===-1 /*|| staticTest.test(url)*/){

        var thumbTest =  /\bt\.jpg&tn=1/i;
        if (thumbTest.test(url)){
          url = req.url = url.replace("&tn=1", "");
          var imagePath = me.static + decodeURI(url);
       // if (me.imageCache[imagePath]){
          if (fs.existsSync(imagePath)) {
            fs.readFile(imagePath, function(err, data) {
              if(err) {
                res.send('error reading thumb');
              } else {
                // set the content type based on the file
                res.contentType('image/jpg');
                res.send(data);
              }   
              res.end();
            });
          }else{
	    var original = imagePath.replace('t.jpg', '_.jpg');
            gm(original)
              .resize(256)
              .write(imagePath, function(err, file){
                if (err){
                  console.log(err);
                  return res.send(err);
                }
                res.contentType('text/plain');
                res.send('creating thumbnail');
              });
          }
          return;
        }
        // Not the right URL. We have no business here. Onwards!
        return next();
      }

      url = url.replace(rootURL, "");
      if (url.charAt(0)==="/"){
        url = url.substring(1, url.length);
      }
      url =decodeURIComponent(url);


      if (url && url!==""){
        var filepath = url.trim()
        , isFile = /\.(jpg|bmp|jpeg|gif|png|tif)$/i
        , istob = /.\.jpg$/i;
     // image = isFile.test(filepath.toLowerCase());
        image = isFile.test(filepath);
        filepath = filepath.split("/");
        if (image){ // If we detect image file name at end, get filename
          image = filepath.pop();
          if ( istob.test(image) ) image = filepath.pop() + '/' + image;
        }
        filepath = filepath.join("/").trim();

        requestParams = {
          album: filepath,
          photo: image
        };

      }

      var getterFunction = (image) ? gallery.getPhoto : gallery.getAlbum;

      getterFunction.apply(gallery, [ requestParams, function(err, data){
        req.gallery = data;
        return next(err);
        //Should we do this here? res.render(data.type + '.ejs', data);
      }]);
    }
  }
};

module.exports = gallery;
