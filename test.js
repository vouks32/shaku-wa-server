import sharp from "sharp";

await sharp('./flyer.jpg')
        .resize({ width: 800 }) // Resize to 500px width
        .jpeg({ quality: 100 }).toFile('output.jpg', (err, info) => {  });