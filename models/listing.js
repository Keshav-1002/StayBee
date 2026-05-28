const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const listingSchema = new Schema({
  title: {
    type: String,
    required: true,
  },
  description: String,
  // Primary image (kept for backward compatibility)
  image: {
    type: String,
    default:
      "https://images.unsplash.com/photo-1519046904884-53103b34b206?q=80&w=1170&auto=format&fit=crop",
    set: (v) =>
      v === ""
        ? "https://images.unsplash.com/photo-1519046904884-53103b34b206?q=80&w=1170&auto=format&fit=crop"
        : v,
  },
  // New: support multiple images per listing
  images: {
    type: [String],
    default: [],
  },
  price: Number,
  priceYearly: {
    type: Number,
    default: null,
  },
  location: String,
  /** Full formatted address from Places / geocoder (optional) */
  locationAddress: {
    type: String,
    default: "",
    trim: true,
  },
  latitude: Number,
  longitude: Number,
  country: String,
  ownerContact: {
    type: String,
    trim: true,
    default: "",
  },
  whatsappNumber: {
    type: String,
    trim: true,
    default: "",
  },
  status: {
    type: String,
    enum: ["Available", "Booked", "Coming Soon"],
    default: "Available",
  },
  averageRating: { type: Number, default: null },
  reviewCount: { type: Number, default: 0 },
  // jiya: Owner field to track who created the listing
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  propertyType: {
    type: String,
    enum: ['PG', 'Hostel', 'Room'],
    default: null,
  },
  roomAccessType: {
    type: String,
    enum: ['Independent', 'Dependent'],
    default: null,
  },
  facilities: {
    type: [String],
    default: [],
  },
  // jiya: Approval status for admin approval system
  approvalStatus: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  // jiya: Timestamp for when listing was approved
  approvedAt: {
    type: Date,
    default: null,
  },
  // jiya: Admin who approved the listing
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
});

const Listing = mongoose.model("Listing", listingSchema);
module.exports = Listing;
