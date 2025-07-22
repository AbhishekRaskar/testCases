const path = require('path');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const webpack = require('webpack');

var config = {
    target: 'node',
    entry: {
      "index/index": './src/index.js',
      "project_fetcher/index": './src/functions/project_fetcher.js',
    },
    externals: [{ "aws-sdk": "aws-sdk", debug: "debug" }],
    output: {
      path: path.resolve(__dirname, 'build'),
      filename: '[name].js',
      library: '[name]',
      libraryTarget: 'umd'
    },
    plugins: [
      new CleanWebpackPlugin(),
      new webpack.DefinePlugin({ "global.GENTLY": false })
    ]
};

// filepath: d:\cync-los-sonarqube-to-jira-integration\webpack.config.js
module.exports = (env, argv) => {
  if (argv.mode === 'development' && !argv.noWatch) {
    config.watch = true;
    config.watchOptions = {
      aggregateTimeout: 2000
    };
  }
  return config;
};