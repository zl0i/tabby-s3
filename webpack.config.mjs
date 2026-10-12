import * as path from 'path'
import * as url from 'url'
import wp from 'webpack'
import { AngularWebpackPlugin } from '@ngtools/webpack'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const isDev = !!process.env.TABBY_DEV

export default {
    target: 'node',
    entry: './src/index.ts',
    context: __dirname,
    devtool: false,
    mode: isDev ? 'development' : 'production',
    optimization: {
        minimize: false,
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'index.js',
        libraryTarget: 'umd',
        publicPath: 'auto',
    },
    resolve: {
        modules: ['src', 'node_modules'].map(x => path.join(__dirname, x)),
        extensions: ['.ts', '.js'],
        // The AWS SDK is bundled into dist; its "browser" entry points would swap in the fetch-based
        // HTTP handler, which S3 endpoints reject without a CORS policy. Resolve the Node.js builds instead.
        mainFields: ['module', 'main'],
    },
    module: {
        rules: [
            { test: /\.ts$/, use: ['@ngtools/webpack'] },
            { test: /\.pug$/, use: ['apply-loader', { loader: 'pug-loader', options: { pretty: true } }] },
            { test: /\.scss$/, use: ['@tabby-gang/to-string-loader', 'css-loader', { loader: 'sass-loader', options: { api: 'modern' } }] },
        ],
    },
    // Provided by Tabby at runtime
    externals: [
        'keytar',
        'ngx-toastr',
        /^@angular/,
        /^@ng-bootstrap/,
        /^@ngx-translate/,
        /^rxjs/,
        /^tabby-/,
    ],
    plugins: [
        new wp.SourceMapDevToolPlugin({
            filename: '[file].map',
            moduleFilenameTemplate: 'webpack-tabby-s3:///[resource-path]',
        }),
        new AngularWebpackPlugin({
            tsconfig: path.resolve(__dirname, 'tsconfig.json'),
            directTemplateLoading: false,
            jitMode: true,
        }),
    ],
}
