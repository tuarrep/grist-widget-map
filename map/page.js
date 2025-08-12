"use strict";

/* global grist, window */

let token = "";
let baseUrl = "";
let amap;
let popups = {};
let selectedTableId = null;
let selectedRowId = null;
let selectedRecords = null;
let mode = 'multi';
let mapSource = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
let mapCopyright = 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)';

const Name = "Name";
const Longitude = "Longitude";
const Latitude = "Latitude";
const TentAccessible = "TentAccessible";
const Difficulty = "Difficulty";
const OneNight = "OneNight";
const Picture = "Picture";

let lastRecord;
let lastRecords;

const selectedRowClusterIconFactory = function () {
    return function (cluster) {
        const childCount = cluster.getChildCount();

        return new L.DivIcon({
            html: `<div>${childCount}</div>`,
            className: "custom-cluster",
            iconSize: new L.Point(40, 40)
        });
    }
};

function showProblem(txt) {
    document.getElementById('map').innerHTML = '<div class="error">' + txt + '</div>';
}

function parseValue(v) {
    if (typeof (v) === 'object' && v !== null && v.value && v.value.startsWith('V(')) {
        const payload = JSON.parse(v.value.slice(2, v.value.length - 1));
        return payload.remote || payload.local || payload.parent || payload;
    }
    return v;
}

function getInfo(rec) {
    return {
        id: rec.id,
        name: parseValue(rec[Name]),
        lng: parseValue(rec[Longitude]),
        lat: parseValue(rec[Latitude]),
        tentAccessible: parseValue(rec[TentAccessible]),
        difficulty: parseValue(rec[Difficulty]),
        oneNight: parseValue(rec[OneNight]),
        pictureUrl: getAttachmentUrl(parseValue(rec[Picture]?.[0])),
    };
}

// Function to clear last added markers. Used to clear the map when new record is selected.
let clearMarkers = () => {
};

let markers = [];

function getMarkerIcon({tentAccessible, difficulty, oneNight} = {tentAccessible: false}) {
    const hospitality = tentAccessible ? 'tent' : 'hammock';

    let color = 'green';
    switch (difficulty) {
        case '0':
            color = 'green';
            break;
        case '<30mn':
            color = 'blue';
            break;
        case '<1h':
            color = 'red';
            break;
        case '>1h':
            color = 'black'
            break;
    }

    return new L.Icon({
        iconUrl: `markers/marker_${hospitality}_${color}.png`,
        shadowUrl: oneNight ? 'markers/marker_work.png' : undefined,
        iconSize: [42, 42],
        iconAnchor: [21, 42],
        popupAnchor: [1, -34],
        shadowSize: [28, 28],
        shadowAnchor: [0, 54],
        shadowPane: 'shadows'
    });
}

async function updateMap(data) {
    ({token, baseUrl} = await grist.docApi.getAccessToken({ readOnly: true }));

    data = data || selectedRecords;
    selectedRecords = data;
    if (!data || data.length === 0) {
        showProblem("No data found yet");
        return;
    }
    if (!(Longitude in data[0] && Latitude in data[0] && Name in data[0])) {
        showProblem("Table does not yet have all expected columns: Name, Longitude, Latitude. You can map custom columns" +
            " in the Creator Panel.");
        return;
    }

    const tiles = L.tileLayer(mapSource, {attribution: mapCopyright});
    const osmStd = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });
    const esriSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
    });

    const error = document.querySelector('.error');
    if (error) {
        error.remove();
    }
    if (amap) {
        try {
            amap.off();
            amap.remove();
        } catch (e) {
            // ignore
            console.warn(e);
        }
    }
    const map = L.map('map', {
        layers: [tiles],
        wheelPxPerZoomLevel: 90,
        zoomControl: false
    });

    map.createPane('shadows').style.zIndex = 630;
    map.createPane('selectedMarker').style.zIndex = 620;
    map.createPane('clusters').style.zIndex = 610;
    map.createPane('otherMarkers').style.zIndex = 600;

    const points = []; //L.LatLng[], used for zooming to bounds of all markers

    popups = {};

    markers = L.markerClusterGroup({
        disableClusteringAtZoom: 15,
        maxClusterRadius: 40,
        showCoverageOnHover: true,
        clusterPane: 'clusters',
        iconCreateFunction: selectedRowClusterIconFactory(() => popups[selectedRowId]),
    });

    markers.on('click', (e) => {
        const id = e.layer.options.id;
        selectMarker(id);
    });

    for (const rec of data) {
        const info = getInfo(rec);
        const {id, name, lng, lat} = info;
        // If the record is in the middle of geocoding, skip it.
        if (String(lng) === '...') {
            continue;
        }
        if (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01) {
            // Stuff at 0,0 usually indicates bad imports/geocoding.
            continue;
        }
        const pt = new L.LatLng(lat, lng);
        points.push(pt);

        const icon = getMarkerIcon(info);

        const marker = L.marker(pt, {
            title: name,
            id: id,
            icon: icon,
            pane: (id === selectedRowId) ? "selectedMarker" : "otherMarkers",
            shadowPane: 'shadows',
        });

        // Warm the browser cache to reduce popup layout changes when opening
        if (info.pictureUrl) {
            const _preload = new Image();
            _preload.decoding = 'async';
            _preload.loading = 'eager';
            _preload.src = info.pictureUrl;
        }

        const popupHtml = createPopupHtml(info, icon);
        marker.bindPopup(popupHtml);
        markers.addLayer(marker);

        popups[id] = marker;
    }
    map.addLayer(markers);

    // Add zoom control (explicitly) and layers control (base layers + overlays)
    L.control.zoom({ position: 'topright' }).addTo(map);
    const baseLayers = {
        'Topo': tiles,
        'OpenStreetMap': osmStd,
        'Satellite': esriSat,
    };
    const overlays = {
        'Markers': markers,
    };
    L.control.layers(baseLayers, overlays, { collapsed: true, position: 'topright' }).addTo(map);

    clearMarkers = () => map.removeLayer(markers);

    try {
        map.fitBounds(new L.LatLngBounds(points), {maxZoom: 15, padding: [0, 0]});
    } catch (err) {
        console.warn('cannot fit bounds');
    }

    function makeSureSelectedMarkerIsShown() {
        const rowId = selectedRowId;

        if (rowId && popups[rowId]) {
            const marker = popups[rowId];
            if (!marker._icon) {
                markers.zoomToShowLayer(marker);
            }
            marker.openPopup();
        }
    }

    amap = map;

    makeSureSelectedMarkerIsShown();
}

function selectMarker(id) {
    // Reset the options from the previously selected marker.
    const previouslyClicked = popups[selectedRowId];
    if (previouslyClicked) {
        previouslyClicked.options.pane = 'otherMarkers';
    }
    const marker = popups[id];
    if (!marker) {
        return null;
    }

    // Remember the new selected marker.
    selectedRowId = id;
    marker.options.pane = 'selectedMarker';

    // Rerender markers in this cluster
    markers.refreshClusters();

    // Update the selected row in Grist.
    grist.setCursorPos?.({rowId: id}).catch(() => {
    });

    return marker;
}


grist.on('message', (e) => {
    if (e.tableId) {
        selectedTableId = e.tableId;
    }
});

function selectOnMap(rec) {
    // If this is already selected row, do nothing (to avoid flickering)
    if (selectedRowId === rec.id) {
        return;
    }

    selectedRowId = rec.id;
    if (mode === 'single') {
        updateMap([rec]);
    } else {
        updateMap();
    }
}

grist.onRecord((record) => {
    if (mode === 'single') {
        // If mappings are not done, we will assume that table has correct columns.
        // This is done to support existing widgets which where configured by
        // renaming column names.
        lastRecord = grist.mapColumnNames(record) || record;
        selectOnMap(lastRecord);
    } else {
        const marker = selectMarker(record.id);
        if (!marker) {
            return;
        }
        markers.zoomToShowLayer(marker);
        marker.openPopup();
    }
});
grist.onRecords((data) => {
    lastRecords = grist.mapColumnNames(data) || data;
    if (mode !== 'single') {
        // If mappings are not done, we will assume that table has correct columns.
        // This is done to support existing widgets which where configured by
        // renaming column names.
        updateMap(lastRecords);
        if (lastRecord) {
            selectOnMap(lastRecord);
        }
    }
});

grist.onNewRecord(() => {
    clearMarkers();
    clearMarkers = () => {
    };
})

grist.ready({
    columns: [
        "Name",
        {name: "Longitude", type: 'Numeric'},
        {name: "Latitude", type: 'Numeric'},
        {name: "TentAccessible", type: 'Bool'},
        {name: "Difficulty", type: 'Choice'},
        {name: "OneNight", type: 'Bool'},
        {name: 'Picture', type: 'Attachments'},
    ],
    allowSelectBy: true,
    requiredAccess : 'full'
});

function getAttachmentUrl(attachmentId) {
    if(!attachmentId || !baseUrl || !token) return null;

    console.log({attachmentId, baseUrl, token})
        return `${baseUrl}/attachments/${attachmentId}/download?auth=${token}`;
}

function createPopupHtml(info) {
    const iconUrl = getMarkerIcon(info).options.iconUrl;
    // Reserve space to prevent layout shift by specifying intrinsic size
    const IMG_W = 138;
    const IMG_H = 78;
    const src = info.pictureUrl ?? iconUrl;
    const alt = info.name ?? '';
    return `
          <div class="popup-content">
            <img class="popup-img" src="${src}" alt="${alt}" width="${IMG_W}" height="${IMG_H}" decoding="async" loading="eager">
            <div class="popup-text">
              <div class="popup-title">${info.name}</div>
              <div class="popup-info">
                <div><span class="label">Durée de marche :</span> ${info.difficulty}</div>
                <div><span class="label">Travail le lendemain</span> ${info.oneNight ? 'OUI' : 'NON'}</div>
                <div><span class="label">Tente :</span> ${info.tentAccessible ? 'OUI' : 'NON'}</div>
              </div>
            </div>
          </div>`;
}
