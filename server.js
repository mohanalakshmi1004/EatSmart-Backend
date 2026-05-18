const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const path = require("path");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Buffer } = require("buffer");
const axios = require("axios");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

// ------------------ DB Connections ------------------
const ecommerceDB = mongoose.createConnection(
  process.env.MONGODB_URL_ECOMMERCE,
  { useNewUrlParser: true, useUnifiedTopology: true }
);

ecommerceDB.on('connected', () => {
  console.log('✅ Ecommerce DB Connected');
});

ecommerceDB.on('error', (err) => {
  console.error('❌ Ecommerce DB Connection Error:', err.message);
});

const authDB = mongoose.createConnection(
  process.env.MONGODB_URL_LOGIN,
  { useNewUrlParser: true, useUnifiedTopology: true }
);

authDB.on('connected', () => {
  console.log('✅ Auth DB Connected');
});

authDB.on('error', (err) => {
  console.error('❌ Auth DB Connection Error:', err.message);
});

// ------------------ Schemas & Models ------------------
const User = authDB.model(
  "User",
  new mongoose.Schema(
    {
      name: { type: String, required: true },
      email: { type: String, required: true, unique: true },
      password: { type: String, required: true },
    },
    { timestamps: true }
  )
);

const Product = ecommerceDB.model(
  "Product",
  new mongoose.Schema({
    id: { type: String, required: true },
    name: { type: String, required: true },
    image: { type: String, required: true },
    category: { type: String, required: true },
    new_price: { type: Number, required: true },
    old_price: { type: Number, required: true },
    date: { type: Date, default: Date.now() },
    available: { type: Boolean, default: true },
    manufacture_date: { type: Date },
    expiry_date: { type: Date },
    shelf_life_days: { type: Number },
    discount_percent: { type: Number, default: 0 },
    discount_applied: { type: Boolean, default: false },
  })
);


const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";

// ------------------ Auth APIs ------------------
app.post("/api/auth/signup", async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const existingUser = await User.findOne({ email });
    if (existingUser)
      return res.status(400).json({ msg: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hashedPassword });
    await user.save();

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });
    res.status(201).json({ user: { id: user._id, name, email }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ user: { id: user._id, name: user.name, email }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error" });
  }
});

// ------------------ Image Upload ------------------
const storage = multer.diskStorage({
  destination: "./Upload/Images",
  filename: (req, file, cb) => {
    return cb(
      null,
      `${file.fieldname}_${Date.now()}${path.extname(file.originalname)}`
    );
  },
});
const upload = multer({ storage: storage });
app.use("/Images", express.static("./Upload/Images"));

app.post("/Upload", upload.single("product"), (req, res) => {
  res.json({
    success: 1,
    imageurl: `http://localhost:${PORT}/Images/${req.file.filename}`,
  });
});

// ------------------ Discount Helper ------------------
function calculateDiscount(expiryDate) {
  if (!expiryDate) return { discountPercent: 0, daysLeft: null };

  const today = new Date();
  const daysLeft = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
  let discountPercent = 0;

  if (daysLeft > 30) discountPercent = 10;
  else if (daysLeft > 14) discountPercent = 30;
  else if (daysLeft > 7) discountPercent = 50;
  else if (daysLeft >= 0) discountPercent = 75;

  return { discountPercent, daysLeft };
}

// ------------------ Product APIs ------------------

app.post("/addproduct", async (req, res) => {
  try {
    let products = await Product.find({});
    let id;
    if (products.length > 0) {
      // ✅ Corrected: Find the maximum ID and add 1 to ensure uniqueness
      const maxId = products.reduce((max, prod) => Math.max(max, Number(prod.id)), 0);
      id = String(maxId + 1);
    } else {
      id = "1";
    }

    let expiryDate = null;
    if (req.body.expiry_date) {
      expiryDate = new Date(req.body.expiry_date);
    } else if (req.body.manufacture_date && req.body.shelf_life_days) {
      let mfg = new Date(req.body.manufacture_date);
      expiryDate = new Date(mfg);
      expiryDate.setDate(mfg.getDate() + Number(req.body.shelf_life_days));
    }

    const { discountPercent, daysLeft } = calculateDiscount(expiryDate);

    const product = new Product({
      id, // This is now guaranteed to be a unique string
      name: req.body.name,
      image: req.body.image,
      category: req.body.category,
      new_price: Number(req.body.new_price),
      old_price: Number(req.body.old_price),
      manufacture_date: req.body.manufacture_date || null,
      expiry_date: expiryDate,
      shelf_life_days: req.body.shelf_life_days || null,
      discount_percent: discountPercent,
      discount_applied: expiryDate ? true : false,
    });

    await product.save();
    res.json({ success: 1, product, daysLeft });
  } catch (err) {
    console.error("❌ Error saving product:", err);
    res.status(500).json({ success: 0, error: "Failed to save product" });
  }
});


app.get("/quickdiscounts", async (req, res) => {
  try {
    let products = await Product.find({ expiry_date: { $ne: null } });

    products = products
      .map((prod) => {
        const { discountPercent, daysLeft } = calculateDiscount(prod.expiry_date);
        let discountedPrice = prod.old_price;
        if (discountPercent > 0) {
          discountedPrice =
            prod.old_price - (prod.old_price * discountPercent) / 100;
        }

        return {
          ...prod.toObject(),
          daysLeft,
          discount_percent: discountPercent,
          discount_applied: true,
          new_price: discountedPrice,
        };
      })
      .filter((prod) => prod.daysLeft > 0); // ✅ Filter out expired items (daysLeft <= 0)

    res.json(products);
  } catch (err) {
    console.error("❌ Error fetching quick discounts:", err);
    res.status(500).json({ error: "Failed to fetch quick discounts" });
  }
});

app.get("/allproducts", async (req, res) => {
  try {
    let products = await Product.find({});
    products = products.map((prod) => {
      const { discountPercent, daysLeft } = calculateDiscount(prod.expiry_date);
      const newPrice =
        discountPercent > 0
          ? prod.old_price - (prod.old_price * discountPercent) / 100
          : prod.old_price;

      return {
        ...prod.toObject(),
        daysLeft,
        discount_percent: discountPercent,
        discount_applied: prod.expiry_date ? true : false,
        new_price: newPrice,
      };
    });

    res.json(products);
  } catch (err) {
    console.error("❌ Error fetching all products:", err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// ------------------ AI Recipe Generator ------------------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post("/smartrecipes", async (req, res) => {
  try {
    const { ingredients } = req.body;

    // Safety Check: Ensure ingredients is an array
    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: "Ingredients must be a non-empty array." });
    }

    // ✅ FIXED: Updated to the current stable model
  const textModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `Generate a detailed recipe using these ingredients: ${ingredients.join(", ")}.
    
    Please provide the response in this exact format:
    Title: [Recipe Name]
    
    Ingredients:
    - [ingredient 1]
    - [ingredient 2]
    
    Instructions:
    [Step-by-step cooking instructions]`;
    
    // ✅ FIXED: Correct SDK execution
    const result = await textModel.generateContent(prompt);
    const recipeText = result.response.text(); 

    // RegEx Parsing
    const titleMatch = recipeText.match(/Title:\s*(.+)/i);
    const ingredientsMatch = recipeText.match(/Ingredients:\s*([\s\S]*?)(?=Instructions:|$)/i);
    const instructionsMatch = recipeText.match(/Instructions:\s*([\s\S]*)$/i);

    const ingredientsList = ingredientsMatch 
      ? ingredientsMatch[1].trim().split("\n").map(i => i.replace(/^[-•*]\s*/, "").trim())
      : [];

    res.json({
      title: titleMatch ? titleMatch[1].trim() : "AI Special Recipe",
      ingredients: ingredientsList,
      instructions: instructionsMatch ? instructionsMatch[1].trim() : recipeText
    });

  } catch (error) {
    console.error("❌ DETAILED API ERROR:", error);
    res.status(500).json({ 
      error: "AI Service Error", 
      details: error.message 
    });
  }
});
// New endpoint: Generate recipe from ingredients using Gemini AI
app.post("/generate-recipe-from-ingredients", async (req, res) => {
  const { ingredients } = req.body;
  
  if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ 
      error: "Please provide at least one ingredient as an array." 
    });
  }

  const ingredientsList = ingredients.join(", ");
  const prompt = `Generate a detailed recipe using these ingredients: ${ingredientsList}.
  
  Please provide the response in this exact format:
  Title: [Recipe Name]
  
  Ingredients:
  - [ingredient 1]
  - [ingredient 2]
  (and so on)
  
  Instructions:
  1. [Step 1]
  2. [Step 2]
  (and so on)
  
  Make it simple, easy to follow, and suitable for home cooking. Prefer Indian/fusion style if possible.`;

  try {
    const textModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await textModel.generateContent(prompt);
    const response = await result.response;
    const recipeText = response.text();

    // Parse the response to extract title, ingredients, and instructions
    const titleMatch = recipeText.match(/Title:\s*(.+?)(?:\n|$)/i);
    const ingredientsMatch = recipeText.match(/Ingredients:\s*([\s\S]*?)(?=Instructions:|$)/i);
    const instructionsMatch = recipeText.match(/Instructions:\s*([\s\S]*?)$/i);

    const title = titleMatch ? titleMatch[1].trim() : "Generated Recipe";
    const ingredientsText = ingredientsMatch ? ingredientsMatch[1].trim() : "";
    const instructionsText = instructionsMatch ? instructionsMatch[1].trim() : recipeText;

    // Parse ingredients list
    const ingredientsList = ingredientsText
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.replace(/^[-•*]\s*/, "").trim())
      .filter((line) => line.length > 0);

    res.json({
      title,
      ingredients: ingredientsList,
      instructions: instructionsText,
    });
  } catch (error) {
    console.error("Error generating recipe from ingredients:", error);
    res.status(500).json({ error: "Failed to generate recipe. Please try again." });
  }
});

// ------------------ Spoonacular API ------------------
const SPOONACULAR_KEY = process.env.SPOONACULAR_API_KEY;

app.get("/foodfacts", async (req, res) => {
  const search_terms = req.query.search_terms;
  if (!search_terms) {
    return res.status(400).json({ error: "search_terms query parameter is required" });
  }

  try {
    const response = await axios.get("https://world.openfoodfacts.org/cgi/search.pl", {
      params: {
        search_terms,
        search_simple: 1,
        json: 1,
        page_size: 1,
      },
      timeout: 10000,
    });

    res.json(response.data);
  } catch (error) {
    console.error("❌ OpenFoodFacts proxy error:", error.message);
    res.status(502).json({ error: "Failed to fetch nutrition data" });
  }
});

app.post("/get-recipe", async (req, res) => {
  const { recipe } = req.body;
  if (!recipe || recipe.trim() === "") {
    return res.status(400).json({ error: "Recipe name is required" });
  }

  try {
    const searchRes = await axios.get(
      "https://api.spoonacular.com/recipes/complexSearch",
      { params: { query: recipe, number: 1, apiKey: SPOONACULAR_KEY } }
    );

    if (!searchRes.data.results || searchRes.data.results.length === 0) {
      return res.json({ error: "Recipe not found in Spoonacular" });
    }

    const recipeId = searchRes.data.results[0].id;
    const detailsRes = await axios.get(
      `https://api.spoonacular.com/recipes/${recipeId}/information`,
      { params: { apiKey: SPOONACULAR_KEY } }
    );

    const { title, extendedIngredients, instructions } = detailsRes.data;
    res.json({
      title,
      ingredients: extendedIngredients.map((ing) => ing.original),
      instructions: instructions || "Instructions not available",
    });
  } catch (error) {
    console.error("❌ Spoonacular API Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch recipe from Spoonacular" });
  }
});

// ------------------ Server ------------------
app.get("/", (req, res) => {
  res.send("🚀 Express is running with Dual DB Support");
});

app.listen(PORT, () => {
  console.log(`🚀 Server is Live on http://localhost:${PORT}`);
});
