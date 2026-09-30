const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

const config = {
  entry: './src/visual.ts',
  output: {
    filename: 'visual.js',
    path: path.join(__dirname, 'dist'),
    library: {
      name: 'WynVisualClass',
      type: 'umd',
    },
    libraryExport: 'default'
  },
  plugins: [
    new MiniCssExtractPlugin({
      filename: 'visual.css',
    }),
  ],
  optimization: {
    minimizer: [new CssMinimizerPlugin({}), new TerserPlugin()],
  },
  module: {
    rules: [
      {
        test: /\.(ts)$/,
        exclude: /node_modules/,
        use: ['babel-loader', 'ts-loader'],
      },
      {
        test: /\.less|.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader', 'less-loader'],
      },
      {
        test: /\.(png|jpg|gif)$/i,
        type: 'asset/inline',
      },
    ],
    unknownContextCritical: false,
  },
  resolve: {
    extensions: ['.ts', '.js', '.json', '.css', '.less'],
  },
  mode: 'development',
};

module.exports = config;