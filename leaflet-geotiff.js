// Ideas from:
// https://github.com/ScanEx/Leaflet.imageTransform/blob/master/src/L.ImageTransform.js
// https://github.com/BenjaminVadant/leaflet-ugeojson

// Depends on:
// https://github.com/constantinius/geotiff.js

// Note this will only work with ESPG:4326 tiffs

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    var L = require('leaflet');
    var GeoTIFF = require('geotiff');
}

(function () {
    try {
        new window.ImageData(new Uint8ClampedArray([0, 0, 0, 0]), 1, 1);
    } catch (e) {
        var ImageDataPolyfill = function ImageDataPolyfill() {
            var args = [].concat(Array.prototype.slice.call(arguments)),
                data = void 0;

            if (args.length < 2) {
                throw new TypeError('Failed to construct "ImageData": 2 arguments required, but only ' + args.length + ' present.');
            }

            if (args.length > 2) {
                data = args.shift();

                if (!(data instanceof Uint8ClampedArray)) {
                    throw new TypeError('Failed to construct "ImageData": parameter 1 is not of type "Uint8ClampedArray"');
                }

                if (data.length !== 4 * args[0] * args[1]) {
                    throw new Error('Failed to construct "ImageData": The input data byte length is not a multiple of (4 * width * height)');
                }
            }

            var width = args[0],
                height = args[1],
                canvas = document.createElement('canvas'),
                ctx = canvas.getContext('2d'),
                imageData = ctx.createImageData(width, height);

            if (data) imageData.data.set(data);
            return imageData;
        };

        window.ImageData = ImageDataPolyfill;
    }
})();

L.LeafletGeotiff = L.ImageOverlay.extend({

    options: {
        arrowSize: 20,
        band: 0,
        image: 0,
        renderer: null,
        rBand: 0,
        gBand: 1,
        bBand: 2,
        alphaBand: 0,    // band to use for (generating) alpha channel
        transpValue: 0   // original band value to interpret as transparent
    },

    initialize: function (url, options) {
        if(typeof(GeoTIFF) === 'undefined'){
            throw new Error("GeoTIFF not defined");
        };

        this._url = url;
        this.raster = {};
        L.Util.setOptions(this, options);

        if (this.options.bounds) {
            this._rasterBounds = L.latLngBounds(options.bounds);
        }
        if (this.options.renderer) {
            this.options.renderer.setParent(this);
        }

        this._getData();
    },
    setURL: function(newURL) {
        this._url = newURL;
        this._getData();
    },
    onAdd: function (map) {
        this._map = map;
        if (!this._image) {
            this._initImage();
        }

        map._panes.overlayPane.appendChild(this._image);

        map.on('moveend', this._reset, this);

        if (map.options.zoomAnimation && L.Browser.any3d) {
            map.on('zoomanim', this._animateZoom, this);
        }

        this._reset();
    },
    onRemove: function (map) {
        map.getPanes().overlayPane.removeChild(this._image);

        map.off('moveend', this._reset, this);

        if (map.options.zoomAnimation) {
            map.off('zoomanim', this._animateZoom, this);
        }
    },
    _getData: function() {
        var self = this;
        var request = new XMLHttpRequest();
        request.onload = function() {
            if (this.status >= 200 && this.status < 400) {
                self._parseTIFF(this.response);
            } //TODO else handle error
        };
        request.open("GET", this._url, true);
        request.responseType = "arraybuffer";
        request.send();
    },
    _parseTIFF: function (arrayBuffer) {
        var self = this;
        let tiff = GeoTIFF.parse(arrayBuffer);
        self.tiff = tiff;
        self.setBand(self.options.band);
        if (!self.options.bounds) {
            var image = self.tiff.getImage(self.options.image)
            var meta = image.getFileDirectory();
            var x_min = meta.ModelTiepoint[3];
            var x_max = x_min + meta.ModelPixelScale[0]*meta.ImageWidth;
            var y_min = meta.ModelTiepoint[4];
            var y_max = y_min - meta.ModelPixelScale[1]*meta.ImageLength;
            self._rasterBounds = L.latLngBounds([[y_min,x_min],[y_max,x_max]]);
            console.log("bounds:", x_min, x_max, y_min, y_max, "meta:", meta);
            self._reset();
        }

    },
    setBand: function (band) {
        var self = this;
        self.options.band = band;

        var image = self.tiff.getImage(self.options.image);
        var data = null;
        if(self.options.NaNtoNoData){
            data = image.readRasters({samples: self.options.samples}).map(function(v){
                return v.map(function(v2){
                    return isNaN(v2)?-9999:v2;
                });
            });
        }else{
            data = image.readRasters({samples: self.options.samples});
        }
        var r = data[self.options.rBand];
        var g = data[self.options.gBand];
        var b = data[self.options.bBand];
        // map transparency value to alpha channel if transpValue is specified
        var a = self.options.transpValue?data[self.options.alphaBand].map(
            function(v){
                // set NaN values transparent
                if(isNaN(v)) return 0;
                // set specified transpValue transparent
                return v==self.options.transpValue?0:255
            }):data[self.options.alphaBand];

        self.raster.data = [r,g,b,a].filter(function (v) {
            return v;
        });
        self.raster.width = image.getWidth();
        self.raster.height = image.getHeight();
        console.log("image", image, "data", data, "raster", self.raster.data);
        self._reset()
    },
    getRasterArray: function () {
        return this.raster.data;
    },
    getRasterCols: function () {
        return this.raster.width;
    },
    getRasterRows: function () {
        return this.raster.height;
    },
    getValueAtLatLng: function (lat, lng) {
        try {
            var x = Math.floor(this.raster.width*(lng - this._rasterBounds._southWest.lng)/(this._rasterBounds._northEast.lng - this._rasterBounds._southWest.lng));
            var y = this.raster.height-Math.ceil(this.raster.height*(lat - this._rasterBounds._southWest.lat)/(this._rasterBounds._northEast.lat - this._rasterBounds._southWest.lat));
            var i = y*this.raster.width+x;
            return this.raster.data[i];
        }
        catch(err) {
            return undefined;
        }
    },
    _animateZoom: function (e) {
        if (L.version >= "1.0") {
            var scale = this._map.getZoomScale(e.zoom),
                offset = this._map._latLngBoundsToNewLayerBounds(this._map.getBounds(), e.zoom, e.center).min;
            L.DomUtil.setTransform(this._image, offset, scale);
        } else {
            var scale = this._map.getZoomScale(e.zoom),
                nw = this._map.getBounds().getNorthWest(),
                se = this._map.getBounds().getSouthEast(),
                topLeft = this._map._latLngToNewLayerPoint(nw, e.zoom, e.center),
                size = this._map._latLngToNewLayerPoint(se, e.zoom, e.center)._subtract(topLeft);
            this._image.style[L.DomUtil.TRANSFORM] =
                L.DomUtil.getTranslateString(topLeft) + ' scale(' + scale + ') ';
        }
    },
    _reset: function () {
        if (this.hasOwnProperty('_map') && this._map) {
            if (this._rasterBounds) {
                topLeft = this._map.latLngToLayerPoint(this._map.getBounds().getNorthWest()),
                    size = this._map.latLngToLayerPoint(this._map.getBounds().getSouthEast())._subtract(topLeft);

                L.DomUtil.setPosition(this._image, topLeft);
                this._image.style.width  = size.x + 'px';
                this._image.style.height = size.y + 'px';

                this._drawImage();
            };
        };
    },
    setClip: function(clipLatLngs) {
        this.options.clip = clipLatLngs;
        this._reset();
    },

    _getPixelByLatLng: function(latLng) {
        var topLeft = this._map.latLngToLayerPoint(this._map.getBounds().getNorthWest());
        var mercPoint = this._map.latLngToLayerPoint(latLng);
        return L.point(mercPoint.x - topLeft.x, mercPoint.y - topLeft.y);
    },

    _clipMaskToPixelPoints: function(i) {
        if (this.options.clip) {
            var topLeft = this._map.latLngToLayerPoint(this._map.getBounds().getNorthWest());
            var pixelClipPoints = [];
            const clip = this.options.clip[i];
            for (var p = 0; p < clip.length; p++) {
                var mercPoint = this._map.latLngToLayerPoint(clip[p]),
                    pixel = L.point(mercPoint.x - topLeft.x, mercPoint.y - topLeft.y);
                pixelClipPoints.push(pixel);
            }
            this._pixelClipPoints = pixelClipPoints;
        } else {
            this._pixelClipPoints = undefined;
        }
    },

    _drawImage: function () {
        if (this.raster.hasOwnProperty('data')) {
            var args = {};
            topLeft = this._map.latLngToLayerPoint(this._map.getBounds().getNorthWest()),
                size = this._map.latLngToLayerPoint(this._map.getBounds().getSouthEast())._subtract(topLeft);
            args.rasterPixelBounds = L.bounds(this._map.latLngToContainerPoint(this._rasterBounds.getNorthWest()),this._map.latLngToContainerPoint(this._rasterBounds.getSouthEast()));
            args.xStart = (args.rasterPixelBounds.min.x>0 ? args.rasterPixelBounds.min.x : 0);
            args.xFinish = (args.rasterPixelBounds.max.x<size.x ? args.rasterPixelBounds.max.x : size.x);
            args.yStart = (args.rasterPixelBounds.min.y>0 ? args.rasterPixelBounds.min.y : 0);
            args.yFinish = (args.rasterPixelBounds.max.y<size.y ? args.rasterPixelBounds.max.y : size.y);
            args.plotWidth = args.xFinish-args.xStart;
            args.plotHeight = args.yFinish-args.yStart;

            if ((args.plotWidth<=0) || (args.plotHeight<=0)) {
                var plotCanvas = document.createElement("canvas");
                plotCanvas.width = size.x;
                plotCanvas.height = size.y;
                var ctx = plotCanvas.getContext("2d");
                ctx.clearRect(0, 0, plotCanvas.width, plotCanvas.height);
                this._image.src = plotCanvas.toDataURL();
                return;
            }

            args.xOrigin = this._map.getPixelBounds().min.x+args.xStart;
            args.yOrigin = this._map.getPixelBounds().min.y+args.yStart;
            args.lngSpan = (this._rasterBounds._northEast.lng - this._rasterBounds._southWest.lng)/this.raster.width;
            args.latSpan = (this._rasterBounds._northEast.lat - this._rasterBounds._southWest.lat)/this.raster.height;

            //Draw image data to canvas and pass to image element
            var plotCanvas = document.createElement("canvas");
            plotCanvas.width = size.x;
            plotCanvas.height = size.y;
            var ctx = plotCanvas.getContext("2d");
            ctx.clearRect(0, 0, plotCanvas.width, plotCanvas.height);

            this.options.renderer.render(this.raster, plotCanvas, ctx, args);
            // mask caused problems and seems to be not needed for our implementation
            //var mask = this.createMask(size, args);
            //ctx.globalCompositeOperation = 'destination-out';
            //ctx.drawImage(mask, 0, 0);

            this._image.src = String(plotCanvas.toDataURL());
        }
    },

    createSubmask: function(size, args, clip) {
        var canvas = document.createElement("canvas");
        canvas.width = size.x;
        canvas.height = size.y;
        var ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (var i = 0; i < clip.length; i++) {
            var ring = clip[i];
            if (i > 0) { //inner ring
                ctx.globalCompositeOperation = 'destination-out';
            }
            ctx.beginPath();
            for (var j = 0; j < ring.length; j++) {
                var pix = this._getPixelByLatLng(ring[j]);
                ctx.lineTo(pix.x, pix.y);
            }
            ctx.fill();
        }
        return canvas;
    },

    createMask: function(size, args) {
        var canvas = document.createElement("canvas");
        canvas.width = size.x;
        canvas.height = size.y;
        var ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillRect(args.xStart, args.yStart, args.plotWidth, args.plotHeight);
        //Draw clipping polygon
        const clip = this.options.clip;
        if (clip) {
            ctx.globalCompositeOperation = 'destination-out';
            for (var idx = 0; idx < clip.length; idx++) {
                var submask = this.createSubmask(size, args, clip[idx])
                ctx.drawImage(submask, 0, 0);
            }
        }
        return canvas;
    },

    transform: function(rasterImageData, args) {
        //Create image data and Uint32 views of data to speed up copying
        var imageData = new ImageData(args.plotWidth, args.plotHeight);
        var outData = imageData.data;
        var outPixelsU32 = new Uint32Array(outData.buffer);
        var inData = rasterImageData.data;
        var inPixelsU32 = new Uint32Array(inData.buffer);

        var zoom = this._map.getZoom();
        var scale = this._map.options.crs.scale(zoom);
        var d = 57.29577951308232; //L.LatLng.RAD_TO_DEG;

        var transformationA = this._map.options.crs.transformation._a;
        var transformationB = this._map.options.crs.transformation._b;
        var transformationC = this._map.options.crs.transformation._c;
        var transformationD = this._map.options.crs.transformation._d;
        if (L.version >= "1.0") {
            transformationA = transformationA*this._map.options.crs.projection.R;
            transformationC = transformationC*this._map.options.crs.projection.R;
        }

        for (var y=0;y<args.plotHeight;y++) {
            var yUntransformed = ((args.yOrigin+y) / scale - transformationD) / transformationC;
            var currentLat = (2 * Math.atan(Math.exp(yUntransformed)) - (Math.PI / 2)) * d;
            var rasterY = this.raster.height-Math.ceil((currentLat - this._rasterBounds._southWest.lat)/args.latSpan);

            for (var x=0;x<args.plotWidth;x++) {
                //Location to draw to
                var index = (y*args.plotWidth+x);

                //Calculate lat-lng of (x,y)
                //This code is based on leaflet code, unpacked to run as fast as possible
                //Used to deal with TIF being EPSG:4326 (lat,lon) and map being EPSG:3857 (m E,m N)
                var xUntransformed = ((args.xOrigin+x) / scale - transformationB) / transformationA;
                var currentLng = xUntransformed * d;
                var rasterX = Math.floor((currentLng - this._rasterBounds._southWest.lng)/args.lngSpan);

                var rasterIndex = (rasterY*this.raster.width+rasterX);

                //Copy pixel value
                outPixelsU32[index] = inPixelsU32[rasterIndex];
            }
        }
        return imageData;
    }

});

L.LeafletGeotiffRenderer = L.Class.extend({

    initialize: function(options) {
        L.setOptions(this, options);
    },

    setParent: function(parent) {
        this.parent = parent;
    },

    render: function(raster, canvas, ctx, args) {
        throw new Error('Abstract class');
    }

});

L.leafletGeotiff = function (url, options) {
    return new L.LeafletGeotiff(url, options);
};

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = L;
}
