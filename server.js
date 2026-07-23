const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = 3001;

const DB_PATH = path.join(__dirname, "db.json");

app.use(cors());
app.use(express.json());



function readDb() {
    return JSON.parse(
        fs.readFileSync(DB_PATH, "utf8")
    );
}

function getBearerToken(authHeader) {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return null;
    }

    const token = authHeader.slice("Bearer ".length).trim();

    return token || null;
}

function findMockUser(db, token) {
    if (!token || !db.users) {
        return null;
    }

    return db.users.find((user) => {
        return user.token === token || user.id === token || user.email === token;
    }) || null;
}

function getMockAuthContext(req) {
    const db = readDb();
    const token = getBearerToken(req.headers.authorization);
    const user = findMockUser(db, token);

    return { db, token, user };
}

function getDeliveryTimestamp(delivery) {
    const timestamp = delivery.sent_at || delivery.delivered_at || delivery.created_at || delivery.timestamp;

    if (!timestamp) {
        return null;
    }

    const parsed = new Date(timestamp);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeStringFilter(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const normalized = String(value).trim();

    return normalized === "" ? null : normalized;
}

function normalizeLimit(value, fallback) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sendProblem(res, status, detail, title) {
    return res.status(status).json({
        type: "ProblemDetails",
        title: title || undefined,
        status,
        detail
    });
}

function parseDateOrNull(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getStationTimestamp(station) {
    return parseDateOrNull(station.last_observed_at || station.status_since || station.updated_at || station.created_at);
}

function parseBoundingBox(value) {
    if (!value) {
        return null;
    }

    const parts = String(value)
        .split(",")
        .map((part) => Number.parseFloat(part.trim()));

    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
        return null;
    }

    return {
        minLng: parts[0],
        minLat: parts[1],
        maxLng: parts[2],
        maxLat: parts[3]
    };
}

function matchesBoundingBox(station, bbox) {
    if (!bbox || !station.location || !Array.isArray(station.location.coordinates)) {
        return true;
    }

    const [lng, lat] = station.location.coordinates;

    return lng >= bbox.minLng && lng <= bbox.maxLng && lat >= bbox.minLat && lat <= bbox.maxLat;
}

function normalizeBoolean(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    if (value === true || value === "true" || value === 1 || value === "1") {
        return true;
    }

    if (value === false || value === "false" || value === 0 || value === "0") {
        return false;
    }

    return null;
}

function requireMockAuth(req, res, allowedRoles = null) {
    const { db, token, user } = getMockAuthContext(req);

    if (!token) {
        sendProblem(res, 401, "Unauthorized", "Unauthorized");
        return null;
    }

    if (!user) {
        sendProblem(res, 404, "User not found", "User not found");
        return null;
    }

    if (allowedRoles && !allowedRoles.includes(user.role)) {
        sendProblem(res, 403, "Access denied", "Forbidden");
        return null;
    }

    return { db, user };
}

function filterStations(stations, filters) {
    let filtered = [...stations];

    if (filters.effective_status) {
        filtered = filtered.filter((station) => station.effective_status === filters.effective_status);
    }

    if (filters.updated_since) {
        const updatedSince = parseDateOrNull(filters.updated_since);

        if (updatedSince) {
            filtered = filtered.filter((station) => {
                const stationDate = getStationTimestamp(station);

                return stationDate && stationDate >= updatedSince;
            });
        }
    }

    const bbox = parseBoundingBox(filters.bbox);

    if (bbox) {
        filtered = filtered.filter((station) => matchesBoundingBox(station, bbox));
    }

    return filtered;
}

function filterMountpoints(mountpoints, filters) {
    let filtered = [...mountpoints];

    if (filters.station_id) {
        filtered = filtered.filter((mountpoint) => mountpoint.station_id === filters.station_id);
    }

    if (filters.review_status) {
        filtered = filtered.filter((mountpoint) => mountpoint.review_status === filters.review_status);
    }

    const isPrimary = normalizeBoolean(filters.is_primary);

    if (isPrimary !== null) {
        filtered = filtered.filter((mountpoint) => Boolean(mountpoint.is_primary) === isPrimary);
    }

    return filtered;
}

function getMaintenanceStatus(maintenance) {
    if (maintenance.status) {
        return maintenance.status;
    }

    const now = new Date();
    const startsAt = parseDateOrNull(maintenance.starts_at);
    const endsAt = parseDateOrNull(maintenance.ends_at);

    if (startsAt && endsAt && now >= startsAt && now <= endsAt) {
        return "in_progress";
    }

    if (startsAt && now < startsAt) {
        return "scheduled";
    }

    if (endsAt && now > endsAt) {
        return "completed";
    }

    return null;
}

function filterMaintenances(maintenances, filters) {
    let filtered = [...maintenances];

    if (filters.station_id) {
        filtered = filtered.filter((maintenance) => maintenance.station_id === filters.station_id);
    }

    if (filters.status) {
        filtered = filtered.filter((maintenance) => getMaintenanceStatus(maintenance) === filters.status);
    }

    if (filters.from) {
        const fromDate = parseDateOrNull(filters.from);

        if (fromDate) {
            filtered = filtered.filter((maintenance) => {
                const startsAt = parseDateOrNull(maintenance.starts_at);

                return startsAt && startsAt >= fromDate;
            });
        }
    }

    if (filters.to) {
        const toDate = parseDateOrNull(filters.to);

        if (toDate) {
            filtered = filtered.filter((maintenance) => {
                const startsAt = parseDateOrNull(maintenance.starts_at);

                return startsAt && startsAt <= toDate;
            });
        }
    }

    return filtered;
}

function filterStatusEvents(events, filters) {
    let filtered = [...events];

    if (filters.from) {
        const fromDate = parseDateOrNull(filters.from);

        if (fromDate) {
            filtered = filtered.filter((event) => {
                const timestamp = parseDateOrNull(event.timestamp || event.created_at || event.occurred_at);

                return timestamp && timestamp >= fromDate;
            });
        }
    }

    if (filters.to) {
        const toDate = parseDateOrNull(filters.to);

        if (toDate) {
            filtered = filtered.filter((event) => {
                const timestamp = parseDateOrNull(event.timestamp || event.created_at || event.occurred_at);

                return timestamp && timestamp <= toDate;
            });
        }
    }

    filtered.sort((left, right) => {
        const leftDate = parseDateOrNull(left.timestamp || left.created_at || left.occurred_at);
        const rightDate = parseDateOrNull(right.timestamp || right.created_at || right.occurred_at);

        if (!leftDate && !rightDate) {
            return 0;
        }

        if (!leftDate) {
            return 1;
        }

        if (!rightDate) {
            return -1;
        }

        return rightDate - leftDate;
    });

    const limit = normalizeLimit(filters.limit, 50);
    const cursorDate = parseDateOrNull(filters.cursor);

    if (cursorDate) {
        filtered = filtered.filter((event) => {
            const timestamp = parseDateOrNull(event.timestamp || event.created_at || event.occurred_at);

            return timestamp && timestamp < cursorDate;
        });
    }

    const paginated = filtered.slice(0, limit);
    const lastItem = paginated[paginated.length - 1];

    return {
        items: paginated,
        count: filtered.length,
        next_cursor: paginated.length === limit && lastItem ? (lastItem.timestamp || lastItem.created_at || lastItem.occurred_at || null) : null
    };
}

function applyEmailDeliveryFilters(deliveries, filters) {
    let filtered = [...deliveries];

    if (filters.station_id) {
        filtered = filtered.filter((delivery) => delivery.station_id === filters.station_id);
    }

    if (filters.status) {
        filtered = filtered.filter((delivery) => delivery.status === filters.status);
    }

    if (filters.from) {
        filtered = filtered.filter((delivery) => delivery.from === filters.from);
    }

    if (filters.to) {
        filtered = filtered.filter((delivery) => delivery.to === filters.to);
    }

    if (filters.from_date) {
        const fromDate = new Date(filters.from_date);

        if (!Number.isNaN(fromDate.getTime())) {
            filtered = filtered.filter((delivery) => {
                const deliveryDate = getDeliveryTimestamp(delivery);

                return deliveryDate && deliveryDate >= fromDate;
            });
        }
    }

    if (filters.to_date) {
        const toDate = new Date(filters.to_date);

        if (!Number.isNaN(toDate.getTime())) {
            filtered = filtered.filter((delivery) => {
                const deliveryDate = getDeliveryTimestamp(delivery);

                return deliveryDate && deliveryDate <= toDate;
            });
        }
    }

    filtered.sort((left, right) => {
        const leftDate = getDeliveryTimestamp(left);
        const rightDate = getDeliveryTimestamp(right);

        if (!leftDate && !rightDate) {
            return 0;
        }

        if (!leftDate) {
            return 1;
        }

        if (!rightDate) {
            return -1;
        }

        return rightDate - leftDate;
    });

    if (filters.cursor) {
        const cursorDate = new Date(filters.cursor);

        if (!Number.isNaN(cursorDate.getTime())) {
            filtered = filtered.filter((delivery) => {
                const deliveryDate = getDeliveryTimestamp(delivery);

                return deliveryDate && deliveryDate < cursorDate;
            });
        }
    }

    const limit = normalizeLimit(filters.limit, 50);
    const paginated = filtered.slice(0, limit);
    const lastItem = paginated[paginated.length - 1];

    return {
        items: paginated,
        count: filtered.length,
        next_cursor: paginated.length === limit && lastItem ? (lastItem.sent_at || lastItem.delivered_at || lastItem.created_at || lastItem.timestamp || null) : null,
    };
}

//1.1 Salud del servicio
app.get("/health", (req, res) => {

    res.status(200).json({
        type: "HealthStatus"
    });

});

app.get("/ready", (req, res) => {

    try {

        readDb();

        res.status(200).json({
            type: "ReadinessStatus"
        });

    } catch (error) {

        res.status(503).json({
            type: "ProblemDetails",
            detail: error.message
        });
    }
});

//1.2 Estaciones, estado e histórico
app.get("/api/v1/stations", (req, res) => {
    const db = readDb();

    if (!db.stations){
        return res.status(404).json({
            type: "ProblemDetails",
            detail: "Stations not found"
        });
    }

    res.status(200).json({
        items: db.stations,
        count: db.stations.length,
        generated_at: new Date().toISOString()
    });
});

app.get("/api/v1/stations/:station_id", (req, res) => {
    const { station_id } = req.params;

    const db = readDb();

    const station = db.stations.find((s) => s.id === station_id);

    if (!station) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Station with id ${station_id} not found`
        });
    }

    res.status(200).json(station);
});

app.get("/api/v1/stations/:station_id/status", (req, res) => {
    const { station_id } = req.params;

    const db = readDb();

    const station = db.stations.find((s) => s.id === station_id);

    if (!station) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Station with id ${station_id} not found`
        });
    }

    res.status(200).json({
        status: station.effective_status,
    });
});

app.patch("/api/v1/stations/:station_id", (req, res) => {
    const { station_id } = req.params;

    const db = readDb();

    const stationIndex = db.stations.findIndex((s) => s.id === station_id);

    if (stationIndex === -1) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Station with id ${station_id} not found`
        });
    }

    const station = db.stations[stationIndex];

    
    Object.assign(station, req.body);
    
    station.last_observed_at = new Date().toISOString();

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

    res.status(200).json(station);
});

app.get("/api/v1/stations/:station_id/status-events", (req, res) => {
    const { station_id } = req.params;

    const db = readDb();

    const station = db.stations.find((s) => s.id === station_id);

    if (!station) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Station with id ${station_id} not found`
        });
    }

    res.status(200).json({
        status_events: station.status_events || [],
    });
});

app.get("/api/v1/stations/:station_id/monthly-uptime", (req, res) => {
    const { station_id } = req.params;

    const db = readDb();

    const station = db.stations.find((s) => s.id === station_id);

    if (!station) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Station with id ${station_id} not found`
        });
    }

    

    res.status(200).json({
        monthly_uptime: station.monthly_uptime || 0,
    });
});

//1.3 Mountpoints
app.get("/api/v1/mountpoints", (req, res) => {
    const db = readDb();

    if (!db.mountpoints){
        return res.status(404).json({
            type: "ProblemDetails",
            detail: "Mountpoints not found"
        });
    }

    res.status(200).json({
        items: db.mountpoints,
        count: db.mountpoints.length,
        next_cursor: null
    });
});

app.get("/api/v1/mountpoints/:mountpoint_id", (req, res) => {
    const { mountpoint_id } = req.params;

    const db = readDb();

    const mountpoint = db.mountpoints.find((m) => m.id === mountpoint_id);

    if (!mountpoint) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Mountpoint with id ${mountpoint_id} not found`
        });
    }

    res.status(200).json(mountpoint);
});

app.post("/api/v1/mountpoints/:mountpoint_id/review", (req, res) => {
    const { mountpoint_id } = req.params;

    const db = readDb();

    const mountpoint = db.mountpoints.find((m) => m.id === mountpoint_id);

    if (!mountpoint) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Mountpoint with id ${mountpoint_id} not found`
        });
    }

    const body = req.body;

    if (!body || !body.decision || !body.station_id || !body.reason || body.make_primary === undefined) {
        return res.status(422).json({
            type: "ProblemDetails",
            detail: "Invalid request body"
        });
    }

    if (mountpoint.station_id != body.station_id) {
        return res.status(409).json({
            type: "ProblemDetails",
            detail: `Mountpoint ${mountpoint_id} does not belong to station ${body.station_id}`
        });
    }   

    if (mountpoint.review_status != body.decision) {
        mountpoint.review_status = body.decision;
    }
    

    if (!mountpoint.reviews) {
        mountpoint.reviews = [];
    }

    mountpoint.reviews.push({
        station_id: body.station_id,
        decision: body.decision,
        make_primary: body.make_primary,
        reason: body.reason,
        timestamp: new Date().toISOString()
    });

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));


    res.status(200).json(mountpoint);
});

app.put("/api/v1/stations/:station_id/primary-mountpoint", (req, res) => {
    const { station_id } = req.params;

    const db = readDb();

    if (!req.body || !req.body.mountpoint_id) {
        return res.status(422).json({
            type: "ProblemDetails",
            detail: "Invalid request body"
        });
    }

    const mountpoint = db.mountpoints.filter((m) => m.station_id === station_id);

    const station = db.stations.find((s) => s.id === station_id);

    if (!station) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Station with id ${station_id} not found`
        });
    }

    if (mountpoint.length === 0) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Mountpoint with id ${req.body.mountpoint_id} not found`
        });
    }

    let encontrado = false;

    mountpoint.forEach((m) => {
        if (m.id === req.body.mountpoint_id) {
            m.is_primary = true;
            encontrado = true;
        } else {
            m.is_primary = false;
        }
    });

    if (!encontrado) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Mountpoint with id ${req.body.mountpoint_id} not found for station ${station_id}`
        });
    }

    station.effective_status = "operational";
    station.status_since = new Date().toISOString();
    station.last_observed_at = new Date().toISOString();

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

    res.status(200).json(station);
});

//1.4 mantenimientos

app.get("/api/v1/maintenances", (req, res) => {
    const db = readDb();

    if (!db.maintenances){
        return res.status(404).json({
            type: "ProblemDetails",
            detail: "Maintenances not found"
        });
    }

    res.status(200).json({
        items: db.maintenances,
        count: db.maintenances.length,
        generated_at: new Date().toISOString()
    });
});

app.get("/api/v1/maintenances/:maintenance_id", (req, res) => {
    const { maintenance_id } = req.params;

    const db = readDb();

    const maintenance = db.maintenances.find((m) => m.id === maintenance_id);

    if (!maintenance) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Maintenance with id ${maintenance_id} not found`
        });
    }

    res.status(200).json(maintenance);
});

app.post("/api/v1/maintenances", (req, res) => {
    const db = readDb();

    const newMaintenance = {
        id: `maintenance-${Date.now()}`,
        ...req.body,
        created_at: new Date().toISOString(),
    };

    db.maintenances.push(newMaintenance);

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

    res.status(201).json(newMaintenance);
});

app.patch("/api/v1/maintenances/:maintenance_id", (req, res) => {
    const { maintenance_id } = req.params;
    const { starts_at, ends_at, reason, notes } = req.body;

    if (starts_at === undefined && ends_at === undefined && reason === undefined && notes === undefined
) {
    return res.status(422).json({
        type: "ProblemDetails",
        detail: "Invalid request body"
    });
}
    const db = readDb();

    const maintenance = db.maintenances.find((m) => m.id === maintenance_id);
    
    if (!maintenance) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Maintenance with id ${maintenance_id} not found`
        });
    }

    if (starts_at !== undefined){
        maintenance.starts_at = starts_at;
    }
    if (ends_at !== undefined){
        maintenance.ends_at = ends_at;
    }
    if (reason !== undefined){
        maintenance.reason = reason;
    }
    if (notes !== undefined){
        maintenance.notes = notes;
    }

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

    res.status(200).json(maintenance);
});

//1.5 perfil, alarmas y usuarios

app.get("/api/v1/me", (req, res) => {
    const auth = requireMockAuth(req, res);

    if (!auth) {
        return;
    }

    const { user } = auth;

    res.status(200).json({
        id: user.id,
        email: user.email,
        role: user.role
    });
});

app.get("/api/v1/me/alert-subscriptions", (req, res) => {
    const auth = requireMockAuth(req, res);

    if (!auth) {
        return;
    }

    const { db, user } = auth;

    const subscriptions = db.users.find((u) => u.id === user.id).alert_subscriptions;

    res.status(200).json({
        subscriptions: subscriptions,
    });
});

app.put("/api/v1/me/alert-subscriptions/:station_id", (req, res) => {
    const auth = requireMockAuth(req, res);

    if (!auth) {
        return;
    }

    const { db, user } = auth;

    if (!req.body || 
        typeof req.body.notify_degraded !== "boolean" || 
        typeof req.body.notify_outage !== "boolean" || 
        typeof req.body.notify_recovery !== "boolean" || 
        typeof req.body.is_active !== "boolean") {
        return res.status(422).json({
            type: "ProblemDetails",
            detail: "Invalid request body"
        });
    }

    const { station_id } = req.params;

    const station = db.stations.find((s) => s.id === station_id);

    if (!station) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Station with id ${station_id} not found`
        });
    }

    const userIndex = db.users.findIndex((u) => u.id === user.id);

    if (userIndex === -1) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `User with id ${user.id} not found`
        });
    }

    const subscriptionExists = db.users[userIndex].alert_subscriptions.some((s) => s.station_id === station_id);

    if (subscriptionExists) {
        db.users[userIndex].alert_subscriptions = db.users[userIndex].alert_subscriptions.filter((s) => s.station_id !== station_id);
    }

    const station_subscription = {
        station_id: station_id,
        notify_degraded: req.body.notify_degraded,
        notify_outage: req.body.notify_outage,
        notify_recovery: req.body.notify_recovery,
        is_active: req.body.is_active
    };

    db.users[userIndex].alert_subscriptions.push(station_subscription);

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

    res.status(200).json({
        subscriptions: db.users[userIndex].alert_subscriptions,
    });
});

app.delete("/api/v1/me/alert-subscriptions/:station_id", (req, res) => {
    const auth = requireMockAuth(req, res);

    if (!auth) {
        return;
    }

    const { db, user } = auth;
    const { station_id } = req.params;

    const station = db.stations.find((s) => s.id === station_id);

    if (!station) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `Station with id ${station_id} not found`
        });
    }

    const userIndex = db.users.findIndex((u) => u.id === user.id);

    if (userIndex === -1) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `User with id ${user.id} not found`
        });
    }

    db.users[userIndex].alert_subscriptions =
        db.users[userIndex].alert_subscriptions.filter(
            (subscription) => subscription.station_id !== station_id
        );

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

    res.status(200).json({
        subscriptions: db.users[userIndex].alert_subscriptions
    });
});

app.get("/api/v1/users", (req, res) => {
    const db = readDb();

    const auth = requireMockAuth(req, res, ["admin"]);

    if (!auth) {
        return;
    }

    listUsers = db.users.map((user) => {
        return {
            id: user.id,
            email: user.email,
            role: user.role
        };
    });

    res.status(200).json({
        users: listUsers,
    });
});

app.patch("/api/v1/users/:user_id", (req, res) => {
    const auth = requireMockAuth(req, res, ["admin"]);

    if (!auth) {
        return;
    }

    const { db } = auth;
    const { user_id } = req.params;
    const { role } = req.body;

    const allowedRoles = ["admin", "usuario", "tecnico"];

    if (!role || !allowedRoles.includes(role)) {
        return res.status(422).json({
            type: "ProblemDetails",
            detail: "Role must be admin, usuario or tecnico"
        });
    }

    const updateUser = db.users.find((u) => u.id === user_id);

    if (!updateUser) {
        return res.status(404).json({
            type: "ProblemDetails",
            detail: `User with id ${user_id} not found`
        });
    }

    updateUser.role = role;

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

    res.status(200).json({
        id: updateUser.id,
        email: updateUser.email,
        role: updateUser.role
    });
});

app.get("/api/v1/email-deliveries", (req, res) => {
    const db = readDb();

    if (!db.email_deliveries){
        return res.status(404).json({
            type: "ProblemDetails",
            detail: "Email deliveries not found"
        });
    }

    const requestFilters = req.body && Object.keys(req.body).length > 0 ? req.body : req.query;

    const filters = {
        station_id: normalizeStringFilter(requestFilters.station_id),
        status: normalizeStringFilter(requestFilters.status),
        from: normalizeStringFilter(requestFilters.from),
        to: normalizeStringFilter(requestFilters.to),
        limit: requestFilters.limit,
        cursor: normalizeStringFilter(requestFilters.cursor),
    };

    const result = applyEmailDeliveryFilters(db.email_deliveries, filters);

    res.status(200).json({
        items: result.items,
        count: result.count,
        next_cursor: result.next_cursor,
    });
});

// si es emulador utiliso localhost, si es dispositivo fisico utilizo la ip de mi computadora.
// ej usan expo en celular nesesitan esta ip y estar en la misma red wifi.
app.listen(PORT, () => {
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
});

