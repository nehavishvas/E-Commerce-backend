function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function enrichProducts(products = []) {
  return products.map((product) => {
    const categoryName = product.category || "General";
    const subcategoryName = product.subcategory || product.brand || categoryName;
    const itemName = product.itemName || product.name;
    const details = product.itemDetails || {
      brand: product.brand,
      description: product.description,
      rating: product.rating,
      countInStock: product.countInStock,
    };

    return {
      ...product,
      category: categoryName,
      categorySlug: product.categorySlug || slugify(categoryName),
      subcategory: subcategoryName,
      subcategorySlug: product.subcategorySlug || slugify(subcategoryName),
      itemName,
      itemSlug: product.itemSlug || slugify(itemName),
      itemDetails: details,
    };
  });
}

function buildMeta(products = []) {
  const priceValues = products.map((product) => product.price);
  const ratingValues = products.map((product) => product.rating || 0);
  const brandCounts = products.reduce((brands, product) => {
    brands.set(product.brand, (brands.get(product.brand) || 0) + 1);
    return brands;
  }, new Map());
  const itemCounts = products.reduce((items, product) => {
    items.set(product.itemName, (items.get(product.itemName) || 0) + 1);
    return items;
  }, new Map());

  const featuredProduct = [...products].sort((left, right) => {
    if ((right.rating || 0) !== (left.rating || 0)) {
      return (right.rating || 0) - (left.rating || 0);
    }

    return left.price - right.price;
  })[0];

  return {
    productCount: products.length,
    reviewCount: products.reduce(
      (total, product) => total + (product.numReviews || 0),
      0
    ),
    inStockCount: products.filter((product) => product.countInStock > 0).length,
    minPrice: priceValues.length ? Math.min(...priceValues) : 0,
    maxPrice: priceValues.length ? Math.max(...priceValues) : 0,
    averageRating: ratingValues.length
      ? Number(
          (
            ratingValues.reduce((total, rating) => total + rating, 0) /
            ratingValues.length
          ).toFixed(1)
        )
      : 0,
    brands: [...brandCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([brand]) => brand),
    featuredProduct: featuredProduct
      ? {
          id: featuredProduct.id,
          name: featuredProduct.name,
          image: featuredProduct.image,
          price: featuredProduct.price,
          brand: featuredProduct.brand,
        }
      : null,
    showcaseImages: [
      ...new Map(
        products
          .map((product) => [product.image, product.image])
          .filter(([image]) => Boolean(image))
      ).values(),
    ].slice(0, 4),
    priceBand:
      !priceValues.length
        ? "Unavailable"
        : Math.max(...priceValues) < 2000
          ? "Budget picks"
          : Math.max(...priceValues) < 10000
            ? "Everyday mid-range"
            : Math.max(...priceValues) < 30000
              ? "Premium choices"
              : "Flagship range",
    topItems: [...itemCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([name]) => name),
  };
}

function normalizeStringList(values = []) {
  if (Array.isArray(values)) {
    return values
      .map((value) => String(value || "").trim())
      .filter(Boolean);
  }

  if (!values) {
    return [];
  }

  return String(values)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function deriveFacts(meta, primaryCount, primaryLabel) {
  return [
    `${primaryCount} ${primaryLabel}`,
    `${meta.brands.length} featured brands`,
    `${meta.inStockCount} ready to ship`,
  ];
}

function deriveShopperNotes(meta, products = []) {
  const cheapest = [...products].sort((left, right) => left.price - right.price)[0];
  const premium = [...products].sort((left, right) => right.price - left.price)[0];

  return [
    meta.priceBand,
    cheapest
      ? `Entry point from ₹${cheapest.price.toLocaleString("en-IN")}`
      : "Fresh catalog updates",
    premium ? `Featured pick: ${premium.brand}` : "Trusted multi-brand mix",
  ];
}

function buildCatalog({
  products = [],
  categories = [],
  subcategories = [],
  items = [],
} = {}) {
  const categoryProductsMap = new Map();
  const subcategoryProductsMap = new Map();
  const itemProductsMap = new Map();
  const subcategoriesByCategoryId = new Map();
  const itemsBySubcategoryId = new Map();

  products.forEach((product) => {
    const categorySlug = product.categorySlug || slugify(product.category);
    const subcategorySlug =
      product.subcategorySlug || slugify(product.subcategory);
    const itemSlug = product.itemSlug || slugify(product.itemName);

    if (!categoryProductsMap.has(categorySlug)) {
      categoryProductsMap.set(categorySlug, []);
    }
    categoryProductsMap.get(categorySlug).push(product);

    if (!subcategoryProductsMap.has(subcategorySlug)) {
      subcategoryProductsMap.set(subcategorySlug, []);
    }
    subcategoryProductsMap.get(subcategorySlug).push(product);

    if (!itemProductsMap.has(itemSlug)) {
      itemProductsMap.set(itemSlug, []);
    }
    itemProductsMap.get(itemSlug).push(product);
  });

  subcategories.forEach((subcategory) => {
    if (subcategory.isActive === false) {
      return;
    }

    if (!subcategoriesByCategoryId.has(subcategory.categoryId)) {
      subcategoriesByCategoryId.set(subcategory.categoryId, []);
    }

    subcategoriesByCategoryId.get(subcategory.categoryId).push(subcategory);
  });

  items.forEach((item) => {
    if (item.isActive === false) {
      return;
    }

    if (!itemsBySubcategoryId.has(item.subcategoryId)) {
      itemsBySubcategoryId.set(item.subcategoryId, []);
    }

    itemsBySubcategoryId.get(item.subcategoryId).push(item);
  });

  const normalizedCategories = categories
    .filter((category) => category.isActive !== false)
    .sort((left, right) => {
      if ((left.sortOrder || 0) !== (right.sortOrder || 0)) {
        return (left.sortOrder || 0) - (right.sortOrder || 0);
      }

      return left.name.localeCompare(right.name);
    });

  return normalizedCategories.map((category) => {
    const categoryProducts = categoryProductsMap.get(category.slug) || [];
    const categoryMeta = buildMeta(categoryProducts);

    const subcategoryNodes = (subcategoriesByCategoryId.get(category.id) || [])
      .sort((left, right) => {
        if ((left.sortOrder || 0) !== (right.sortOrder || 0)) {
          return (left.sortOrder || 0) - (right.sortOrder || 0);
        }

        return left.name.localeCompare(right.name);
      })
      .map((subcategory) => {
        const subcategoryProducts =
          subcategoryProductsMap.get(subcategory.slug) || [];
        const subcategoryMeta = buildMeta(subcategoryProducts);

        const itemNodes = (itemsBySubcategoryId.get(subcategory.id) || [])
          .sort((left, right) => {
            if ((left.sortOrder || 0) !== (right.sortOrder || 0)) {
              return (left.sortOrder || 0) - (right.sortOrder || 0);
            }

            return left.name.localeCompare(right.name);
          })
          .map((item) => {
            const itemProducts = itemProductsMap.get(item.slug) || [];
            const itemMeta = buildMeta(itemProducts);

            return {
              id: item.id,
              name: item.name,
              slug: item.slug,
              description: item.description || "",
              heroImage:
                item.heroImage || itemMeta.featuredProduct?.image || null,
              gallery: normalizeStringList(item.gallery).length
                ? normalizeStringList(item.gallery)
                : itemMeta.showcaseImages,
              highlights: normalizeStringList(item.highlights),
              productIds: itemProducts.map((product) => product.id),
              meta: itemMeta,
            };
          });

        return {
          id: subcategory.id,
          name: subcategory.name,
          slug: subcategory.slug,
          meta: {
            ...subcategoryMeta,
            itemCount: itemNodes.length,
            description:
              subcategory.description ||
              `Browse ${subcategory.name.toLowerCase()} from live catalog data.`,
            heroImage:
              subcategory.heroImage ||
              subcategoryMeta.featuredProduct?.image ||
              null,
            gallery: normalizeStringList(subcategory.gallery).length
              ? normalizeStringList(subcategory.gallery)
              : subcategoryMeta.showcaseImages,
            highlights: normalizeStringList(subcategory.highlights),
            facts: normalizeStringList(subcategory.facts).length
              ? normalizeStringList(subcategory.facts)
              : deriveFacts(subcategoryMeta, itemNodes.length, "item groups"),
            shopperNotes: normalizeStringList(subcategory.shopperNotes).length
              ? normalizeStringList(subcategory.shopperNotes)
              : deriveShopperNotes(subcategoryMeta, subcategoryProducts),
            itemSpotlights: itemNodes.slice(0, 4).map((item) => ({
              name: item.name,
              slug: item.slug,
              productCount: item.meta.productCount,
              image: item.heroImage || item.meta.featuredProduct?.image || null,
            })),
            heroStats: [
              {
                label: "Products",
                value: subcategoryMeta.productCount,
              },
              {
                label: "Range",
                value: `₹${subcategoryMeta.minPrice.toLocaleString("en-IN")}+`,
              },
              {
                label: "Rating",
                value: subcategoryMeta.averageRating,
              },
            ],
          },
          items: itemNodes,
        };
      });

    return {
      id: category.id,
      name: category.name,
      slug: category.slug,
      meta: {
        ...categoryMeta,
        subcategoryCount: subcategoryNodes.length,
        itemCount: subcategoryNodes.reduce(
          (total, subcategory) => total + subcategory.items.length,
          0
        ),
        description:
          category.description ||
          `Explore ${category.name.toLowerCase()} from live catalog data.`,
        heroImage:
          category.heroImage || categoryMeta.featuredProduct?.image || null,
        gallery: normalizeStringList(category.gallery).length
          ? normalizeStringList(category.gallery)
          : categoryMeta.showcaseImages,
        highlights: normalizeStringList(category.highlights),
        facts: normalizeStringList(category.facts).length
          ? normalizeStringList(category.facts)
          : deriveFacts(categoryMeta, subcategoryNodes.length, "subcategories"),
        shopperNotes: normalizeStringList(category.shopperNotes).length
          ? normalizeStringList(category.shopperNotes)
          : deriveShopperNotes(categoryMeta, categoryProducts),
        featuredSubcategories: subcategoryNodes.slice(0, 4).map((subcategory) => ({
          name: subcategory.name,
          slug: subcategory.slug,
          image:
            subcategory.meta.heroImage ||
            subcategory.meta.featuredProduct?.image ||
            null,
          productCount: subcategory.meta.productCount,
        })),
        heroStats: [
          {
            label: "Subcategories",
            value: subcategoryNodes.length,
          },
          {
            label: "Items",
            value: subcategoryNodes.reduce(
              (total, subcategory) => total + subcategory.items.length,
              0
            ),
          },
          {
            label: "Price band",
            value: categoryMeta.priceBand,
          },
        ],
      },
      subcategories: subcategoryNodes,
    };
  });
}

module.exports = {
  buildCatalog,
  buildMeta,
  enrichProducts,
  normalizeStringList,
  slugify,
};
