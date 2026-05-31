require("dotenv").config();
const express = require("express");
const app = express();
const mongoose = require("mongoose");
const Listing = require("./models/listing.js");
const User = require("./models/user.js");
const Review = require("./models/review.js");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require("ejs-mate");
const multer = require("multer");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const mongoUrl = "mongodb://127.0.0.1:27017/wanderlust";

// Multer configuration for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, "public", "uploads"));
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + ext);
  },
});

const imageFileFilter = function (req, file, cb) {
  const allowedTypes = /jpeg|jpg|png/;
  const extname = allowedTypes.test(
    path.extname(file.originalname).toLowerCase(),
  );
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    return cb(null, true);
  } else {
    cb(new Error("Only JPG, JPEG, and PNG image files are allowed"));
  }
};

const upload = multer({
  storage: storage,
  fileFilter: imageFileFilter,
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride("_method"));
app.engine("ejs", ejsMate);
app.use(express.static(path.join(__dirname, "/public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "staybee-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    },
  }),
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session?.user || null;
  res.locals.hideSearch = false;
  res.locals.googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || "";
  next();
});

const PROPERTY_TYPES = ["PG", "Hostel", "Room"];
const ROOM_ACCESS_TYPES = ["Independent", "Dependent"];
const FACILITIES_LIST = [
  "Wi-Fi",
  "CCTV",
  "Geyser",
  "Inverter",
  "Air Conditioner (AC)",
  "Parking",
  "Laundry",
  "Water Supply",
  "Attached Bathroom",
  "Kitchen Access",
  "Power Backup",
  "Study Table",
  "Security Guard",
];

function parsePropertyType(raw) {
  if (!raw || typeof raw !== "string") return null;
  return PROPERTY_TYPES.includes(raw.trim()) ? raw.trim() : null;
}

function parseRoomAccessType(raw) {
  if (!raw || typeof raw !== "string") return null;
  return ROOM_ACCESS_TYPES.includes(raw.trim()) ? raw.trim() : null;
}

function parseFacilities(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => FACILITIES_LIST.includes(v));
}

function parsePriceYearly(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return !isNaN(n) && n > 0 ? n : null;
}

function parseListingGeoFields(listingBody) {
  if (!listingBody || typeof listingBody !== "object") return {};
  const latRaw = listingBody.latitude;
  const lngRaw = listingBody.longitude;
  const addr = (listingBody.locationAddress || "").trim();
  const emptyLat =
    latRaw === undefined || latRaw === null || String(latRaw).trim() === "";
  const emptyLng =
    lngRaw === undefined || lngRaw === null || String(lngRaw).trim() === "";
  if (emptyLat || emptyLng) {
    return { hasGeo: false };
  }
  const lat = parseFloat(latRaw);
  const lng = parseFloat(lngRaw);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return { hasGeo: false };
  }
  return {
    hasGeo: true,
    latitude: lat,
    longitude: lng,
    locationAddress: addr || undefined,
  };
}

const requireLogin = (req, res, next) => {
  if (!req.session?.user) return res.redirect("/login");
  return next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session?.user) return res.redirect("/login");
  if (req.session.user.role !== "admin")
    return res.status(403).send("Forbidden");
  return next();
};

// jiya: Middleware to check if user owns the listing
const requireOwnership = (req, res, next) => {
  if (!req.session?.user) return res.redirect("/login");
  // jiya: Admins can access all listings, users can only access their own
  return next();
};

main()
  .then(() => {
    console.log("connected to DB");
  })
  .catch((err) => {
    console.log(err);
  });

async function main() {
  await mongoose.connect(mongoUrl);
  const legacy = await Listing.find({
    rating: { $exists: true },
    averageRating: null,
  });
  for (const l of legacy) {
    if (l.rating != null) {
      await Listing.findByIdAndUpdate(l._id, {
        averageRating: l.rating,
        reviewCount: 1,
        $unset: { rating: 1 },
      });
    }
  }
  // Back-fill priceYearly: null for documents that pre-date the field
  await Listing.updateMany(
    { priceYearly: { $exists: false } },
    { $set: { priceYearly: null } },
  );
  // Back-fill facilities for documents that pre-date the field
  await Listing.updateMany(
    { facilities: { $exists: false } },
    { $set: { facilities: [] } },
  );
  // Back-fill propertyType / roomAccessType for documents that pre-date the split
  await Listing.updateMany(
    { propertyType: { $exists: false } },
    { $set: { propertyType: null } },
  );
  await Listing.updateMany(
    { roomAccessType: { $exists: false } },
    { $set: { roomAccessType: null } },
  );
}

app.get("/", (req, res) => {
  if (!req.session?.user) return res.redirect("/login");
  return res.redirect("/listings");
});

app.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/listings");
  res.locals.hideSearch = true;
  res.render("auth/login.ejs", { error: null });
});

app.get("/register", (req, res) => {
  if (req.session?.user) return res.redirect("/listings");
  res.locals.hideSearch = true;
  res.render("auth/register.ejs", { error: null });
});

app.post("/register", async (req, res) => {
  try {
    const username = (req.body?.username || "").trim();
    const password = req.body?.password || "";
    const confirmPassword = req.body?.confirmPassword || "";
    const role = req.body?.role === "admin" ? "admin" : "user";
    const adminSignupSecret = req.body?.adminSignupSecret || "";

    if (!username)
      return res
        .status(400)
        .render("auth/register.ejs", { error: "Username is required." });
    if (password.length < 4)
      return res.status(400).render("auth/register.ejs", {
        error: "Password must be at least 4 characters.",
      });
    if (password !== confirmPassword)
      return res
        .status(400)
        .render("auth/register.ejs", { error: "Passwords do not match." });

    if (role === "admin") {
      const requiredSecret = process.env.ADMIN_SIGNUP_SECRET || "staybee-admin";
      if (adminSignupSecret !== requiredSecret) {
        return res.status(400).render("auth/register.ejs", {
          error: "Invalid admin secret. Ask your admin for the secret.",
        });
      }
    }

    const existing = await User.findOne({ username });
    if (existing)
      return res
        .status(409)
        .render("auth/register.ejs", { error: "Username already exists." });

    const passwordHash = await bcrypt.hash(password, 10);
    await User.create({ username, passwordHash, role });

    res.redirect("/login");
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).render("auth/register.ejs", {
      error: "Something went wrong. Please try again.",
    });
  }
});

app.post("/login", async (req, res) => {
  try {
    const username = (req.body?.username || "").trim();
    const password = req.body?.password || "";

    if (!username || !password) {
      return res.status(400).render("auth/login.ejs", {
        error: "Username and password are required.",
      });
    }

    const user = await User.findOne({ username });
    if (!user)
      return res
        .status(401)
        .render("auth/login.ejs", { error: "Invalid username or password." });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok)
      return res
        .status(401)
        .render("auth/login.ejs", { error: "Invalid username or password." });

    req.session.user = {
      id: user._id.toString(),
      name: user.username,
      role: user.role,
    };
    res.redirect("/listings");
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).render("auth/login.ejs", {
      error: "Something went wrong. Please try again.",
    });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/listings", async (req, res) => {
  if (!req.session?.user) return res.redirect("/login");
  const { minPrice, maxPrice, location, sort, lat, lng, radiusKm } = req.query;

  // jiya: Only show approved listings to all users (including admins)
  const filter = { approvalStatus: "approved" };

  if (minPrice) {
    filter.price = { ...filter.price, $gte: Number(minPrice) };
  }

  if (maxPrice) {
    filter.price = { ...filter.price, $lte: Number(maxPrice) };
  }

  if (location) {
    filter.location = { $regex: location, $options: "i" };
  }

  const requestLat =
    lat != null && String(lat).trim() !== "" ? parseFloat(lat) : null;
  const requestLng =
    lng != null && String(lng).trim() !== "" ? parseFloat(lng) : null;
  const useNear = Number.isFinite(requestLat) && Number.isFinite(requestLng);
  const effectiveRadiusKm =
    radiusKm != null && String(radiusKm).trim() !== ""
      ? Math.max(1, Math.min(200, parseFloat(radiusKm)))
      : 1;

  function haversineKm(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371; // km
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  let allListing = [];
  if (useNear) {
    // Fetch without DB-side geo index; filter/sort in memory.
    const base = await Listing.find(filter);
    const withCoords = base
      .filter(
        (l) => Number.isFinite(l.latitude) && Number.isFinite(l.longitude),
      )
      .map((l) => ({
        listing: l,
        distanceKm: haversineKm(
          requestLat,
          requestLng,
          Number(l.latitude),
          Number(l.longitude),
        ),
      }))
      .filter((x) => x.distanceKm <= effectiveRadiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    if (withCoords.length > 0) {
      allListing = withCoords.map((x) => x.listing);
    } else {
      // If nothing matches (or no coords in DB), fall back to existing behavior.
      allListing = base;
      if (sort === "price_asc")
        allListing.sort((a, b) => (a.price || 0) - (b.price || 0));
      else if (sort === "price_desc")
        allListing.sort((a, b) => (b.price || 0) - (a.price || 0));
    }
  } else {
    let query = Listing.find(filter);
    if (sort === "price_asc") query = query.sort({ price: 1 });
    else if (sort === "price_desc") query = query.sort({ price: -1 });
    allListing = await query;
  }

  // Rating sort: applied after geo/non-geo block so it works for both paths.
  // Listings with no rating (null) are always pushed to the end.
  if (sort === "rating_desc") {
    allListing.sort(
      (a, b) => (b.averageRating ?? -1) - (a.averageRating ?? -1),
    );
  } else if (sort === "rating_asc") {
    allListing.sort(
      (a, b) => (a.averageRating ?? Infinity) - (b.averageRating ?? Infinity),
    );
  }

  let userFavouriteIds = [];
  if (req.session?.user?.id) {
    const u = await User.findById(req.session.user.id).select("favourites");
    userFavouriteIds = (u?.favourites || []).map((id) => id.toString());
  }

  const filters = {
    minPrice: minPrice || "",
    maxPrice: maxPrice || "",
    location: location || "",
    sort: sort || "",
    lat: useNear ? String(requestLat) : "",
    lng: useNear ? String(requestLng) : "",
    radiusKm: useNear ? String(effectiveRadiusKm) : "",
  };

  res.render("listings/index", { allListing, filters, userFavouriteIds });
});

// jiya: User NEW Route - for creating listings (pending approval)
app.get("/listings/new", requireLogin, (req, res) => {
  res.render("listings/new.ejs", { error: null });
});

// jiya: Admin NEW Route - disabled for admins as requested
app.get("/admin/listings/new", requireAdmin, (req, res) => {
  res
    .status(403)
    .send(
      "Admins cannot create listings directly. Users create listings for approval.",
    );
});

//Show route

app.get("/listings/:id", async (req, res) => {
  if (!req.session?.user) return res.redirect("/login");
  let { id } = req.params;
  const listing = await Listing.findById(id);
  let isFavourite = false;
  let userReview = null;
  if (req.session?.user?.id && listing) {
    const u = await User.findById(req.session.user.id).select("favourites");
    isFavourite = (u?.favourites || []).some(
      (fid) => fid.toString() === listing._id.toString(),
    );
    userReview = await Review.findOne({
      listing: id,
      author: req.session.user.id,
    });
  }
  const reviews = await Review.find({ listing: id })
    .populate("author", "username")
    .sort({ createdAt: -1 });
  const err = req.query.err || null;
  res.render("listings/show.ejs", {
    listing,
    isFavourite,
    reviews,
    userReview,
    err,
  });
});

// jiya: User listing creation route (requires approval)
app.post(
  "/listings",
  requireLogin,
  upload.array("images", 10),
  async (req, res) => {
    try {
      const rawListing = req.body.listing || {};
      const geo = parseListingGeoFields(rawListing);
      const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
      if (mapsKey && !geo.hasGeo) {
        return res.status(400).render("listings/new.ejs", {
          error:
            "Please select a precise location on the map (search for an address or tap the map to drop a pin).",
        });
      }

      const listingData = { ...rawListing };
      delete listingData.latitude;
      delete listingData.longitude;
      delete listingData.locationAddress;

      listingData.priceYearly = parsePriceYearly(listingData.priceYearly);
      listingData.propertyType = parsePropertyType(listingData.propertyType);
      listingData.roomAccessType = parseRoomAccessType(
        listingData.roomAccessType,
      );
      listingData.facilities = parseFacilities(listingData.facilities);

      if (!listingData.status) listingData.status = "Available";

      // jiya: Set owner and approval status
      listingData.owner = req.session.user.id;
      listingData.approvalStatus = "pending";

      if (req.files && req.files.length > 0) {
        const imagePaths = req.files.map((file) => `/uploads/${file.filename}`);
        listingData.images = imagePaths;
        // Also set primary image for backward compatibility
        listingData.image = imagePaths[0];
      }

      if (geo.hasGeo) {
        listingData.latitude = geo.latitude;
        listingData.longitude = geo.longitude;
        if (geo.locationAddress) {
          listingData.locationAddress = geo.locationAddress;
        }
      }

      const newlisting = new Listing(listingData);
      await newlisting.save();
      res.redirect("/my-listings");
    } catch (err) {
      console.error("Error creating listing:", err);
      res.status(500).send("Error creating listing. Please try again.");
    }
  },
);

// jiya: Admin listing creation route - disabled
app.post(
  "/admin/listings",
  requireAdmin,
  upload.array("images", 10),
  async (req, res) => {
    res
      .status(403)
      .send(
        "Admins cannot create listings directly. Users create listings for approval.",
      );
  },
);

// jiya: Edit route - allows users to edit their own listings
app.get("/listings/:id/edit", requireOwnership, async (req, res) => {
  let { id } = req.params;
  const listing = await Listing.findById(id);

  if (!listing) {
    return res.status(404).send("Listing not found.");
  }

  // jiya: Check if user owns the listing or is admin
  if (
    req.session.user.role !== "admin" &&
    listing.owner.toString() !== req.session.user.id
  ) {
    return res.status(403).send("You can only edit your own listings.");
  }

  res.render("listings/edit.ejs", { listing, error: null });
});

// jiya: Admin edit route - disabled
app.get("/admin/listings/:id/edit", requireAdmin, async (req, res) => {
  res
    .status(403)
    .send(
      "Admins cannot edit listings directly. Users edit their own listings.",
    );
});

// jiya: Update route - allows users to update their own listings
app.put(
  "/listings/:id",
  requireOwnership,
  upload.array("images", 10),
  async (req, res) => {
    try {
      let { id } = req.params;
      const listing = await Listing.findById(id);

      if (!listing) return res.status(404).send("Listing not found.");

      // jiya: Check if user owns the listing or is admin
      if (
        req.session.user.role !== "admin" &&
        listing.owner.toString() !== req.session.user.id
      ) {
        return res.status(403).send("You can only update your own listings.");
      }

      const rawListing = req.body.listing || {};
      const geo = parseListingGeoFields(rawListing);
      const updatedData = { ...rawListing };
      delete updatedData.latitude;
      delete updatedData.longitude;
      delete updatedData.locationAddress;

      updatedData.priceYearly = parsePriceYearly(updatedData.priceYearly);
      if ("propertyType" in rawListing) {
        updatedData.propertyType = parsePropertyType(updatedData.propertyType);
      } else {
        delete updatedData.propertyType;
      }
      if ("roomAccessType" in rawListing) {
        updatedData.roomAccessType = parseRoomAccessType(
          updatedData.roomAccessType,
        );
      } else {
        delete updatedData.roomAccessType;
      }
      updatedData.facilities = parseFacilities(updatedData.facilities);

      if (!updatedData.status) updatedData.status = "Available";

      const deleteImagesRaw = req.body.deleteImages;
      const deleteImages = Array.isArray(deleteImagesRaw)
        ? deleteImagesRaw
        : deleteImagesRaw
          ? [deleteImagesRaw]
          : [];

      const existingImages = Array.isArray(listing.images)
        ? listing.images
        : [];
      const remainingImages = existingImages.filter(
        (imgPath) => !deleteImages.includes(imgPath),
      );
      let finalImages = remainingImages;

      if (req.files && req.files.length > 0) {
        const imagePaths = req.files.map((file) => `/uploads/${file.filename}`);
        // Keep existing images and append newly uploaded ones.
        finalImages = [...remainingImages, ...imagePaths];
      }

      updatedData.images = finalImages;
      if (finalImages.length > 0) {
        updatedData.image = finalImages[0];
      } else {
        updatedData.image =
          "https://images.unsplash.com/photo-1519046904884-53103b34b206?q=80&w=1170&auto=format&fit=crop";
      }

      const setFields = { ...updatedData };
      if (geo.hasGeo) {
        setFields.latitude = geo.latitude;
        setFields.longitude = geo.longitude;
        setFields.locationAddress = geo.locationAddress || "";
      }

      // jiya: Reset approval status if listing was edited and not yet approved
      if (
        listing.approvalStatus === "pending" ||
        listing.approvalStatus === "rejected"
      ) {
        setFields.approvalStatus = "pending";
        setFields.approvedAt = null;
        setFields.approvedBy = null;
      }

      const updateDoc = geo.hasGeo
        ? { $set: setFields }
        : {
            $set: setFields,
            $unset: { latitude: 1, longitude: 1, locationAddress: 1 },
          };

      await Listing.findByIdAndUpdate(id, updateDoc);
      res.redirect(`/listings/${id}`);
    } catch (err) {
      console.error("Error updating listing:", err);
      res.status(500).send("Error updating listing. Please try again.");
    }
  },
);

// jiya: Admin update route - disabled
app.put(
  "/admin/listings/:id",
  requireAdmin,
  upload.array("images", 10),
  async (req, res) => {
    res
      .status(403)
      .send(
        "Admins cannot update listings directly. Users update their own listings.",
      );
  },
);

// jiya: DELETE ROUTE - allows users to delete their own listings
app.delete("/listings/:id", requireOwnership, async (req, res) => {
  let { id } = req.params;
  const listing = await Listing.findById(id);

  if (!listing) {
    return res.status(404).send("Listing not found.");
  }

  // jiya: Check if user owns the listing or is admin
  if (
    req.session.user.role !== "admin" &&
    listing.owner.toString() !== req.session.user.id
  ) {
    return res.status(403).send("You can only delete your own listings.");
  }

  let deletedListing = await Listing.findByIdAndDelete(id);
  console.log(deletedListing);

  // jiya: Redirect to appropriate page based on user role
  if (req.session.user.role === "admin") {
    res.redirect("/admin/pending-listings");
  } else {
    res.redirect("/my-listings");
  }
});

// jiya: Admin delete route - disabled
app.delete("/admin/listings/:id", requireAdmin, async (req, res) => {
  res
    .status(403)
    .send(
      "Admins cannot delete listings directly. Users delete their own listings.",
    );
});

// jiya: My Listings route - shows user's own listings
app.get("/my-listings", requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const userListings = await Listing.find({ owner: userId })
    .sort({ createdAt: -1 })
    .populate("owner", "username");

  res.render("listings/my-listings.ejs", { allListing: userListings });
});

// jiya: Admin pending listings route
app.get("/admin/pending-listings", requireAdmin, async (req, res) => {
  // jiya: Handle potential data inconsistency - try multiple approaches
  let pendingListings = await Listing.find({ approvalStatus: "pending" })
    .sort({ createdAt: -1 })
    .populate("owner", "username");

  // jiya: If no results, try without populate first
  if (pendingListings.length === 0) {
    const pendingWithoutPopulate = await Listing.find({
      approvalStatus: "pending",
    }).sort({ createdAt: -1 });

    // jiya: Try to populate only those that have an owner
    pendingListings = [];
    for (const listing of pendingWithoutPopulate) {
      if (listing.owner) {
        try {
          const populated = await Listing.findById(listing._id).populate(
            "owner",
            "username",
          );
          pendingListings.push(populated);
        } catch (err) {
          // jiya: If populate fails, add without owner
          pendingListings.push(listing);
        }
      } else {
        // jiya: Add listings without owner
        pendingListings.push(listing);
      }
    }
  }

  res.render("admin/pending-listings.ejs", { allListing: pendingListings });
});

// jiya: Admin approved listings history
app.get("/admin/approved-listings", requireAdmin, async (req, res) => {
  const approvedListings = await Listing.find({ approvalStatus: "approved" })
    .sort({ approvedAt: -1 })
    .populate("owner", "username")
    .populate("approvedBy", "username");

  res.render("admin/approved-listings.ejs", { allListing: approvedListings });
});

// jiya: Admin rejected listings route
app.get("/admin/rejected-listings", requireAdmin, async (req, res) => {
  const rejectedListings = await Listing.find({ approvalStatus: "rejected" })
    .sort({ createdAt: -1 })
    .populate("owner", "username");

  res.render("admin/rejected-listings.ejs", { allListing: rejectedListings });
});

// jiya: Admin approve listing route
app.post("/admin/listings/:id/approve", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const listing = await Listing.findById(id);

    if (!listing) {
      return res.status(404).send("Listing not found.");
    }

    if (listing.approvalStatus !== "pending") {
      return res.status(400).send("Listing is not pending approval.");
    }

    await Listing.findByIdAndUpdate(id, {
      approvalStatus: "approved",
      approvedAt: new Date(),
      approvedBy: req.session.user.id,
    });

    res.redirect("/admin/pending-listings");
  } catch (err) {
    console.error("Error approving listing:", err);
    res.status(500).send("Error approving listing.");
  }
});

// jiya: Admin reject listing route
app.post("/admin/listings/:id/reject", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const listing = await Listing.findById(id);

    if (!listing) {
      return res.status(404).send("Listing not found.");
    }

    if (listing.approvalStatus !== "pending") {
      return res.status(400).send("Listing is not pending approval.");
    }

    await Listing.findByIdAndUpdate(id, {
      approvalStatus: "rejected",
    });

    res.redirect("/admin/pending-listings");
  } catch (err) {
    console.error("Error rejecting listing:", err);
    res.status(500).send("Error rejecting listing.");
  }
});

// FAVOURITES (WISHLIST)
app.get("/favourites", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.user.id).populate("favourites");
  const allListing = (user?.favourites || []).filter(Boolean);
  res.render("listings/favourites.ejs", { allListing });
});

app.post("/listings/:id/favourite", requireLogin, async (req, res) => {
  const { id } = req.params;
  const userId = req.session.user.id;
  await User.findByIdAndUpdate(userId, { $addToSet: { favourites: id } });
  const referer = req.get("Referer") || `/listings/${id}`;
  res.redirect(referer);
});

app.delete("/listings/:id/favourite", requireLogin, async (req, res) => {
  const { id } = req.params;
  const userId = req.session.user.id;
  await User.findByIdAndUpdate(userId, { $pull: { favourites: id } });
  const referer = req.get("Referer") || `/listings/${id}`;
  res.redirect(referer);
});

app.post("/listings/:id/favourite/toggle", requireLogin, async (req, res) => {
  const { id } = req.params;
  const userId = req.session.user.id;
  const user = await User.findById(userId).select("favourites");

  let isFavourite = false;
  if (user) {
    const alreadyFavourite = (user.favourites || []).some(
      (favId) => favId.toString() === id,
    );
    if (alreadyFavourite) {
      user.favourites = (user.favourites || []).filter(
        (favId) => favId.toString() !== id,
      );
      isFavourite = false;
    } else {
      user.favourites.push(id);
      isFavourite = true;
    }
    await user.save();
  }

  const wantsJson =
    req.xhr ||
    (req.get("Accept") || "").includes("application/json") ||
    req.get("X-Requested-With") === "XMLHttpRequest";

  if (wantsJson) {
    return res.json({ success: true, isFavourite });
  }

  const referer = req.get("Referer") || `/listings/${id}`;
  return res.redirect(referer);
});

async function updateListingRating(listingId) {
  const reviews = await Review.find({ listing: listingId });
  const avg = reviews.length
    ? Math.round(
        (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10,
      ) / 10
    : null;
  await Listing.findByIdAndUpdate(listingId, {
    averageRating: avg,
    reviewCount: reviews.length,
  });
}

app.post("/listings/:id/reviews", requireLogin, async (req, res) => {
  const { id } = req.params;
  const userId = req.session.user.id;
  if (req.session.user.role === "admin")
    return res.status(403).send("Admins cannot post reviews.");
  const existing = await Review.findOne({ listing: id, author: userId });
  if (existing) return res.redirect(`/listings/${id}?err=already_reviewed`);
  const rating = parseInt(req.body.rating, 10);
  if (!rating || rating < 1 || rating > 5)
    return res.redirect(`/listings/${id}?err=invalid_rating`);
  await Review.create({
    listing: id,
    author: userId,
    rating,
    comment: (req.body.comment || "").trim(),
  });
  await updateListingRating(id);
  res.redirect(`/listings/${id}`);
});

app.put("/reviews/:reviewId", requireLogin, async (req, res) => {
  const { reviewId } = req.params;
  const review = await Review.findById(reviewId);
  if (!review) return res.status(404).send("Review not found.");
  if (review.author.toString() !== req.session.user.id)
    return res.status(403).send("You can only edit your own review.");
  const rating = parseInt(req.body.rating, 10);
  if (!rating || rating < 1 || rating > 5)
    return res.redirect(`/listings/${review.listing}?err=invalid_rating`);
  review.rating = rating;
  review.comment = (req.body.comment || "").trim();
  await review.save();
  await updateListingRating(review.listing.toString());
  res.redirect(`/listings/${review.listing}`);
});

app.listen(5000, () => {
  console.log("Server is running at:");
  console.log("http://localhost:5000");
});
