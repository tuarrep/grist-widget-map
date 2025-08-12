"use strict";

/* global grist, window */

let amap;
let popups = {};
let selectedTableId = null;
let selectedRowId = null;
let selectedRecords = null;
let mode = 'multi';
let mapSource = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
let mapCopyright = 'ap data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)';

const Name = "Name";
const Longitude = "Longitude";
const Latitude = "Latitude";
const TentAccessible = "TentAccessible";
const Difficulty = "Difficulty";
const OneNight = "OneNight";

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
    };
}

// Function to clear last added markers. Used to clear the map when new record is selected.
let clearMakers = () => {
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
        shadowPane: 'shadow-pane'
    });
}

function updateMap(data) {
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
        wheelPxPerZoomLevel: 90
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
        selectMaker(id);
    });

    for (const rec of data) {
        const {id, name, lng, lat} = getInfo(rec);
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

        const icon = getMarkerIcon(getInfo(rec));

        const marker = L.marker(pt, {
            title: name,
            id: id,
            icon: icon,
            pane: (id === selectedRowId) ? "selectedMarker" : "otherMarkers",
            shadowPane: 'shadows',
        });

        marker.bindPopup(name);
        markers.addLayer(marker);

        popups[id] = marker;
    }
    map.addLayer(markers);

    clearMakers = () => map.removeLayer(markers);

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

function selectMaker(id) {
    // Reset the options from the previously selected marker.
    const previouslyClicked = popups[selectedRowId];
    if (previouslyClicked) {
        previouslyClicked.pane = 'otherMarkers';
    }
    const marker = popups[id];
    if (!marker) {
        return null;
    }

    // Remember the new selected marker.
    selectedRowId = id;
    previouslyClicked.pane = 'selectedMarker';

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
        const marker = selectMaker(record.id);
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
    clearMakers();
    clearMakers = () => {
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
    ],
    allowSelectBy: true,
});
